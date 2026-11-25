// Endless mode: cloud sync logic (phase 3). Pure: no DOM, no Firebase. The cloud is reached through an
// adapter with one method, runTransaction(fn), where fn gets { get(name), set(name, data), delete(name) } for
// the user's documents users/{uid}/srs/{name}. cloud_firebase.js provides the real adapter (Firestore Lite);
// the tests use an in-memory fake with the same interface.
//
// Cloud layout:
//   meta: { v: 1, epoch, mt, cm: [32 × ms], W, baseline, wbMt, wiped? }
//   c00 … c31: { v: 1, epoch, mt, d: JSON string { key: compactState | tombstone } }
// An item's chunk is fmix32(fnv1a(key)) % 32, so it never moves as the pool grows.
//
// Merge per item (QA 11/24): higher rev, then newer mt, then the smaller encoding (deterministic).
// Every local change bumps rev (Undo restores values with a new rev); a first sight that was undone
// leaves a tombstone { del: 1, rev, mt }, pruned after 30 days on both sides.
//
// A sync is two-way, in one transaction:
//   - read meta (1 read); reset epoch / wiped checks;
//   - read only the chunks another device changed since this device last saw them (meta.cm > lastSeenCm);
//   - merge: cloud-winning items (and tombstones) come back as localUpdates for the local store;
//     local-winning items go up;
//   - write the dirty chunks (from local data: this device already holds everything merged into them)
//     and meta with the new cm entries.
// A load is the same with nothing dirty: 1 read when nothing changed elsewhere.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SrsSync = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const NCHUNK = 32;
    const SYNC_EVERY = 25;                  // answers between timed syncs
    const MIN_SYNC_MS = 60 * 1000;          // at least this long between answer/hidden-triggered syncs
    const TOMB_TTL_MS = 30 * 24 * 3600 * 1000;
    const CHUNK_MAX_CHARS = 300000;         // the rules cap d.size() at this
    const DAY0 = Date.UTC(2026, 0, 1);      // cleanDays are sent as day numbers from 2026-01-01

    function fnv1a(str) {
        let h = 0x811c9dc5;
        for (const ch of String(str)) {
            let c = ch.codePointAt(0);
            // hash the UTF-8 bytes so every engine agrees
            const bytes = c < 0x80 ? [c] : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 63)]
                : c < 0x10000 ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)]
                : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
            for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
        }
        return h >>> 0;
    }
    // FNV-1a's low bits are weak for keys that differ only in repeated parts: mix (murmur3 fmix32) before % 32
    function fmix32(h) {
        h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
        return h >>> 0;
    }
    const chunkIndex = key => fmix32(fnv1a(key)) % NCHUNK;
    const chunkName = i => 'c' + (i < 10 ? '0' : '') + i;
    const zeros = () => Array(NCHUNK).fill(0);

    // ------------------------------------------------------------------ compact encoding
    const dayNum = d => Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - DAY0) / 86400000);
    const dayStr = n => { const t = new Date(DAY0 + n * 86400000); const p = x => (x < 10 ? '0' : '') + x;
                         return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`; };
    const num = x => (x ? x : 0);                                   // full precision: a cloud round trip changes nothing
    // [st, s, d, lr, reps, lapses, seen, correct, cleanDays, recent, ft, grad, last, rev, mt]
    function encodeState(s) {
        if (s && s.del) return [-1, s.rev || 0, s.mt || 0];
        return [s.st === 'memory' ? 1 : 0, num(s.s), num(s.d), s.lr || 0, s.reps || 0, s.lapses || 0, s.seen || 0,
                s.correct || 0, (s.cleanDays || []).map(dayNum),
                (s.recent || []).map(([c, r]) => c + (r === null || r === undefined ? '' : r)).join(','),
                s.ft ? 1 : 0, s.grad || 0, s.last || 0, s.rev || 0, s.mt || 0];
    }
    function decodeState(a) {
        if (a[0] === -1) return { del: 1, rev: a[1], mt: a[2] };
        return { st: a[0] === 1 ? 'memory' : 'learning', s: a[1], d: a[2], lr: a[3], reps: a[4], lapses: a[5], seen: a[6],
                 correct: a[7], cleanDays: a[8].map(dayStr),
                 recent: a[9] ? a[9].split(',').map(x => [x[0], x.length > 1 ? Number(x.slice(1)) : null]) : [],
                 ft: a[10] === 1, grad: a[11] || null, last: a[12], rev: a[13], mt: a[14] };
    }
    function encodeChunk(entries) {
        const keys = Object.keys(entries).sort();
        const o = {};
        for (const k of keys) o[k] = encodeState(entries[k]);
        return JSON.stringify(o);
    }
    function decodeChunk(d) {
        const o = d ? JSON.parse(d) : {};
        const out = {};
        for (const [k, a] of Object.entries(o)) out[k] = decodeState(a);
        return out;
    }

    // ------------------------------------------------------------------ merge
    // a, b: states or tombstones (null = absent). -> the winner
    function winner(a, b) {
        if (!a) return b; if (!b) return a;
        const ra = a.rev || 0, rb = b.rev || 0;
        if (ra !== rb) return ra > rb ? a : b;
        const ma = a.mt || 0, mb = b.mt || 0;
        if (ma !== mb) return ma > mb ? a : b;
        const ea = JSON.stringify(encodeState(a)), eb = JSON.stringify(encodeState(b));
        return ea <= eb ? a : b;
    }
    const same = (a, b) => JSON.stringify(a ? encodeState(a) : null) === JSON.stringify(b ? encodeState(b) : null);
    const expiredTomb = (x, now) => x && x.del && (now - (x.mt || 0)) > TOMB_TTL_MS;

    // The local entries of one chunk: states plus tombstones
    function localChunk(L, i) {
        const out = {};
        for (const [k, s] of Object.entries(L.states || {})) if (chunkIndex(k) === i) out[k] = s;
        for (const [k, t] of Object.entries(L.tombs || {})) if (chunkIndex(k) === i && !out[k]) out[k] = Object.assign({ del: 1 }, t);
        return out;
    }

    // ------------------------------------------------------------------ the sync
    // L (local view, read only): { states, tombs: {key: {rev, mt}}, dirty: [keys], epoch, lastSeenCm[32], W, baseline, wbMt,
    //                              pendingReset, forceUpload }
    // -> { status: 'ok' | 'reset' | 'wiped', reads, writes, localUpdates: {key: state | {del,rev,mt}}, prunedTombs: [keys],
    //      epoch, lastSeenCm, meta: { W, baseline, wbMt } | null, written: [chunk names], syncedDirty: [keys] }
    async function sync(adapter, L, now) {
        return adapter.runTransaction(async tx => {
            let reads = 0, writes = 0;
            const rm = await tx.get('meta'); reads++;
            const remote = rm ? { epoch: rm.epoch || 0, cm: (rm.cm && rm.cm.length === NCHUNK) ? rm.cm.slice() : zeros(),
                                  W: rm.W, baseline: rm.baseline, wbMt: rm.wbMt || 0, wiped: !!rm.wiped }
                              : { epoch: 0, cm: zeros(), W: undefined, baseline: undefined, wbMt: 0, wiped: false };
            const base = { reads, writes, localUpdates: {}, prunedTombs: [], meta: null, written: [], syncedDirty: [] };

            // a reset made on this device: push it (all chunks, new epoch)
            if (L.pendingReset) {
                const epoch = Math.max((L.epoch || 0), remote.epoch + 1);
                const cm = zeros().map(() => now);
                for (let i = 0; i < NCHUNK; i++) {
                    tx.set(chunkName(i), { v: 1, epoch, mt: now, d: encodeChunk(localChunk(L, i)) }); writes++;
                }
                const W = L.W, baseline = L.baseline || [];
                tx.set('meta', { v: 1, epoch, mt: now, cm, W, baseline, wbMt: L.wbMt || now, wiped: false }); writes++;
                return Object.assign(base, { status: 'ok', reads, writes, epoch, lastSeenCm: cm, written: 'all', resetPushed: true,
                                             syncedDirty: (L.dirty || []).slice() });
            }
            if (remote.wiped && !L.forceUpload) return Object.assign(base, { status: 'wiped', reads, epoch: remote.epoch, lastSeenCm: L.lastSeenCm });
            if (remote.epoch > (L.epoch || 0)) return Object.assign(base, { status: 'reset', reads, epoch: remote.epoch, lastSeenCm: zeros() });
            const epoch = Math.max(L.epoch || 0, remote.epoch);

            const seen = (L.lastSeenCm && L.lastSeenCm.length === NCHUNK) ? L.lastSeenCm : zeros();
            const dirtyIdx = new Set((L.dirty || []).map(chunkIndex));
            const all = !!L.forceUpload;
            const changed = new Set();
            for (let i = 0; i < NCHUNK; i++) if (remote.cm[i] > seen[i]) changed.add(i);
            const newSeen = seen.slice();
            const cm = remote.cm.slice();
            const localUpdates = {}, pruned = [];

            for (let i = 0; i < NCHUNK; i++) {
                const isDirty = all || dirtyIdx.has(i);
                if (!changed.has(i) && !isDirty) continue;
                let remoteEntries = null;
                if (changed.has(i)) {
                    const doc = await tx.get(chunkName(i)); reads++;
                    remoteEntries = doc && (doc.epoch || 0) >= epoch ? decodeChunk(doc.d) : {};
                }
                const local = localChunk(L, i);
                const merged = {};
                const keys = new Set([...Object.keys(local), ...Object.keys(remoteEntries || {})]);
                for (const k of keys) {
                    const l = local[k] || null, r = remoteEntries ? (remoteEntries[k] || null) : null;
                    const w = remoteEntries ? winner(l, r) : l;
                    if (!w) continue;
                    if (expiredTomb(w, now)) { if (l && l.del) pruned.push(k); continue; }
                    merged[k] = w;
                    if (remoteEntries && r && w === r && !same(l, r)) localUpdates[k] = r;
                }
                // write when this device changed something in the chunk (or on a forced upload)
                const remoteStr = remoteEntries ? encodeChunk(Object.fromEntries(Object.entries(remoteEntries).filter(([, x]) => !expiredTomb(x, now)))) : null;
                const mergedStr = encodeChunk(merged);
                if (isDirty && (all || remoteStr === null || remoteStr !== mergedStr)) {
                    if (mergedStr.length > CHUNK_MAX_CHARS) throw Object.assign(new Error('chunk too large'), { code: 'chunk-too-large' });
                    tx.set(chunkName(i), { v: 1, epoch, mt: now, d: mergedStr }); writes++;
                    cm[i] = now;
                    base.written.push(chunkName(i));
                }
                newSeen[i] = cm[i];
            }
            // meta: W and baseline, last writer wins (wbMt)
            let metaOut = null, pushWB = false;
            if ((L.wbMt || 0) > remote.wbMt) pushWB = true;
            else if (remote.wbMt > (L.wbMt || 0) && remote.W !== undefined) metaOut = { W: remote.W, baseline: remote.baseline || [], wbMt: remote.wbMt };
            if (base.written.length || pushWB || all || (!rm && (L.dirty || []).length)) {
                const W = pushWB || !rm ? L.W : remote.W, baseline = pushWB || !rm ? (L.baseline || []) : (remote.baseline || []);
                const wbMt = pushWB || !rm ? (L.wbMt || 0) : remote.wbMt;
                const meta = { v: 1, epoch, mt: now, cm, wbMt, wiped: false };
                if (typeof W === 'number') meta.W = W;
                meta.baseline = baseline || [];
                tx.set('meta', meta); writes++;
            }
            return Object.assign(base, { status: 'ok', reads, writes, localUpdates, prunedTombs: pruned, epoch, lastSeenCm: newSeen,
                                         meta: metaOut, syncedDirty: (L.dirty || []).slice() });
        });
    }

    // Delete my cloud data: the 32 chunks go; a small meta tombstone stays so no other device re-uploads.
    async function deleteCloud(adapter, L, now) {
        return adapter.runTransaction(async tx => {
            const rm = await tx.get('meta');
            const epoch = Math.max(L.epoch || 0, rm ? (rm.epoch || 0) : 0) + 1;
            for (let i = 0; i < NCHUNK; i++) tx.delete(chunkName(i));
            tx.set('meta', { v: 1, epoch, mt: now, cm: zeros(), wbMt: 0, wiped: true, baseline: [] });
            return { epoch, reads: 1, writes: 1, deletes: NCHUNK };
        });
    }

    // Apply a sync result to the local view L (mutates and returns L). startRevs: { key: rev } of the dirty items
    // when the sync started; an item changed again while the sync ran stays dirty.
    // -> L, with L.changedKeys (items written into the local store) and L.wipedRemote / L.resetRemote flags
    function applyResult(L, res, startRevs) {
        L.changedKeys = [];
        if (res.status === 'reset') {                              // reset on another device: adopt it
            L.states = {}; L.tombs = {}; L.dirty = []; L.epoch = res.epoch; L.lastSeenCm = zeros();
            L.pendingReset = false; L.resetRemote = true;
            return L;
        }
        if (res.status === 'wiped') { L.wipedRemote = true; return L; }
        for (const [k, x] of Object.entries(res.localUpdates || {})) {
            if (x.del) { delete L.states[k]; L.tombs[k] = { rev: x.rev, mt: x.mt }; }
            else { L.states[k] = x; delete L.tombs[k]; }
            L.changedKeys.push(k);
        }
        for (const k of res.prunedTombs || []) delete L.tombs[k];
        const rev = k => (L.states[k] ? L.states[k].rev : L.tombs[k] ? L.tombs[k].rev : null);
        const synced = new Set(res.syncedDirty || []);
        L.dirty = (L.dirty || []).filter(k => !synced.has(k) || (startRevs && startRevs[k] !== undefined && rev(k) !== startRevs[k]));
        L.epoch = res.epoch; L.lastSeenCm = res.lastSeenCm; L.pendingReset = false; L.forceUpload = false;
        if (res.meta) { L.W = res.meta.W; L.baseline = res.meta.baseline; L.wbMt = res.meta.wbMt; }
        return L;
    }
    function revsOf(L) {
        const out = {};
        for (const k of L.dirty || []) out[k] = L.states[k] ? L.states[k].rev : L.tombs[k] ? L.tombs[k].rev : null;
        return out;
    }

    // ------------------------------------------------------------------ when to sync
    // reason: 'answers' | 'hidden' | 'end' | 'reset' | 'delete' | 'load' | 'signin'
    // st: { dirtyCount, lastSyncAt, answersSinceSync, pausedUntil }
    function shouldSync(reason, st, now) {
        if (st.pausedUntil && now < st.pausedUntil && reason !== 'delete') return false;
        if (reason === 'reset' || reason === 'delete' || reason === 'load' || reason === 'signin') return true;
        if (!st.dirtyCount) return false;                                   // nothing to send
        if (reason === 'end') return true;                                  // session end ignores the minimum
        if (now - (st.lastSyncAt || 0) < MIN_SYNC_MS) return false;         // tab switching must not spam writes
        if (reason === 'answers') return st.answersSinceSync >= SYNC_EVERY;
        return reason === 'hidden';
    }

    // Account binding: a device that synced with one Google account never merges another one silently.
    // -> 'first' (never synced: upload what is here), 'same', 'other' (ask the user)
    function bindCheck(localUid, newUid) {
        if (!localUid) return 'first';
        return localUid === newUid ? 'same' : 'other';
    }

    // The next midnight in America/Los_Angeles (when the Spark quotas reset), as ms
    function nextPacificMidnight(now) {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map(p => [p.type, p.value]));
        const secs = ((+parts.hour % 24) * 3600) + (+parts.minute * 60) + (+parts.second);
        return now - secs * 1000 + 24 * 3600 * 1000 - (now % 1000);
    }

    return { NCHUNK, SYNC_EVERY, MIN_SYNC_MS, TOMB_TTL_MS, CHUNK_MAX_CHARS, fnv1a, fmix32, chunkIndex, chunkName, zeros,
             encodeState, decodeState, encodeChunk, decodeChunk, winner, same, localChunk, sync, deleteCloud, applyResult, revsOf,
             shouldSync, bindCheck, nextPacificMidnight };
}));
