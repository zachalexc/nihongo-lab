// Kanji Match: cloud sync (R5, match-plan decision 10). Pure logic plus a small controller; no DOM,
// no Firebase. The cloud is reached through an adapter with runTransaction(fn), where fn gets
// { get(name), set(name, data) } for users/{uid}/match/{name} (match_cloud.js, or a fake in tests).
//
// Cloud layout (each doc { v: 1, mt, d: JSON string }, d ≤ 900,000 characters; meta is { v: 1, mt }):
//   meta                    when anything was last written
//   settings                { v, s: synced settings + upd + by, played: { deck: [levels] }, bests, days }
//   deck-kanji-meaning …    { v, devs: [deviceIds], items: { id: compactState }, conf: { pairKey: confusion } }
// The board log stays local.
//
// Merge: item states and confusions by latest upd (tie: higher deviceId wins); bests = best per key;
// days = union (a day on both sides keeps the larger count of each field); settings by latest upd;
// played levels = union. Nothing is written to the cloud until the remote has been read and merged,
// all inside one transaction; local data changes only after that transaction succeeded.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MatchSync = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const Core = typeof module === 'object' && module.exports ? require('./match_core.js') : self.MatchCore;
    'use strict';

    const V = 1;
    const MAX_CHARS = 900000;                    // firestore.rules caps d.size() at this
    const DECKS = ['kanji-meaning', 'word-reading', 'word-kanji'];
    // R6: deck B (word-kanji, 11,080 cards) is split over two docs, deck-word-kanji and deck-word-kanji-b,
    // so a fully seen deck stays far below Firestore's 1 MiB doc limit (Japanese ids are 3 bytes a character).
    const SHARDS = { 'word-kanji': 2 };
    const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1', 'X'];
    // Settings that stay on this device (or are merged on their own)
    const LOCAL_ONLY = ['persistAsked', 'iosTipDismissed', 'played', 'upd', 'by'];
    const DAY0 = Date.UTC(2026, 0, 1);
    const DAY_RE = /^\d{4}-\d\d-\d\d$/;
    const pad = x => (x < 10 ? '0' : '') + x;
    const dn = d => (typeof d === 'string' && DAY_RE.test(d)
        ? Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - DAY0) / 86400000) : d);
    const ds = n => { if (typeof n !== 'number') return n;
                      const t = new Date(DAY0 + n * 86400000);
                      return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
    const deckDoc = deck => 'deck-' + deck;
    const shardDoc = (deck, i) => deckDoc(deck) + (i ? '-' + String.fromCharCode(97 + i) : '');
    const deckDocs = deck => Array.from({ length: SHARDS[deck] || 1 }, (_, i) => shardDoc(deck, i));
    const docNames = () => DECKS.flatMap(deckDocs);
    function shardOf(id, n) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % n; }
    const confShard = (key, c, n) => shardOf((c && c.a) || key, n);
    const sortObj = o => { const r = {}; Object.keys(o || {}).sort().forEach(k => { r[k] = o[k]; }); return r; };

    class SyncError extends Error {
        constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
    }

    // ------------------------------------------------------------------ compact item states
    // [box, due, seen, misses, lapses, weakShows, weakRun, unsureDays, today.day, today.weakShows,
    //  upd − lastSeen, lastGrade, upd, device index, {other fields}?]   (days as numbers from 2026-01-01)
    const ITEM_FIELDS = ['box', 'due', 'seen', 'misses', 'lapses', 'weakShows', 'weakRun', 'unsureDays', 'today',
                         'lastSeen', 'lastGrade', 'upd', 'by'];
    const nz = x => (x === undefined ? null : x);
    function encItem(s, devIdx) {
        const t = s.today;
        const a = [nz(s.box), nz(dn(s.due)), nz(s.seen), nz(s.misses), nz(s.lapses), nz(s.weakShows), nz(s.weakRun),
                   s.unsureDays ? s.unsureDays.map(dn) : null, t ? nz(dn(t.day)) : null, t ? nz(t.weakShows) : null,
                   s.lastSeen === undefined ? null : (s.upd || 0) - s.lastSeen, nz(s.lastGrade), s.upd || 0, devIdx];
        let extra = null;
        for (const k in s) if (!ITEM_FIELDS.includes(k)) (extra || (extra = {}))[k] = s[k];
        if (extra) a.push(extra);
        return a;
    }
    function decItem(a, devs) {
        const s = {};
        const put = (k, v) => { if (v !== null && v !== undefined) s[k] = v; };
        put('box', a[0]); put('due', ds(a[1])); put('seen', a[2]); put('misses', a[3]); put('lapses', a[4]);
        put('weakShows', a[5]); put('weakRun', a[6]);
        if (a[7]) s.unsureDays = a[7].map(ds);
        if (a[8] !== null) { s.today = { day: ds(a[8]) }; if (a[9] !== null) s.today.weakShows = a[9]; }
        if (a[10] !== null) s.lastSeen = a[12] - a[10];
        put('lastGrade', a[11]); s.upd = a[12];
        s.by = devs[a[13]] || '';
        if (a[14]) Object.assign(s, a[14]);
        return s;
    }

    // ------------------------------------------------------------------ merge
    // true if r should replace l (latest upd; tie: higher device id; same device and time: keep l)
    function remoteWins(l, r, localDev) {
        const lu = l.upd || 0, ru = r.upd || 0;
        if (ru !== lu) return ru > lu;
        return String(r.by || '') > String(l.by || localDev);
    }
    function mergeMap(local, remote, localDev) {
        const out = Object.assign({}, local);
        for (const k in remote || {}) {
            if (!(k in out) || remoteWins(out[k], remote[k], localDev)) out[k] = remote[k];
        }
        return out;
    }
    function betterBest(a, b) {
        if (!a) return b; if (!b) return a;
        if (a.misses !== b.misses) return a.misses < b.misses ? a : b;
        if (a.activeMs !== b.activeMs) return a.activeMs < b.activeMs ? a : b;
        return String(a.boardId || '') <= String(b.boardId || '') ? a : b;
    }
    function mergeBests(l, r) {
        const out = Object.assign({}, l);
        for (const k in r || {}) out[k] = betterBest(out[k], r[k]);
        return out;
    }
    function mergeDays(l, r) {
        const out = Object.assign({}, l);
        for (const k in r || {}) {
            if (!out[k]) { out[k] = r[k]; continue; }
            const a = out[k], b = r[k];
            out[k] = Object.assign({}, b, a, { boards: Math.max(a.boards || 0, b.boards || 0),
                misses: Math.max(a.misses || 0, b.misses || 0), activeMs: Math.max(a.activeMs || 0, b.activeMs || 0) });
        }
        return out;
    }
    function normPlayed(p) {
        const out = {};
        for (const d of Object.keys(p || {}).sort()) {
            const l = (p[d] || []).filter((x, i, a) => a.indexOf(x) === i);
            l.sort((a, b) => { const i = LEVELS.indexOf(a), j = LEVELS.indexOf(b);
                               return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || (a < b ? -1 : a > b ? 1 : 0); });
            out[d] = l;
        }
        return out;
    }
    function mergePlayed(l, r) {
        const out = {};
        for (const d of new Set(Object.keys(l || {}).concat(Object.keys(r || {}))))
            out[d] = ((l && l[d]) || []).concat((r && r[d]) || []);
        return normPlayed(out);
    }
    const synced = st => { const o = {}; for (const k in st || {}) if (!LOCAL_ONLY.includes(k)) o[k] = st[k]; return o; };
    const localOnly = st => { const o = {}; for (const k of LOCAL_ONLY) if (st && k in st) o[k] = st[k]; return o; };

    // state: { settings, bests, days, items: { deck: map }, confusions: { deck: map } }
    function merge(local, remote, localDev) {
        const ls = local.settings || {};
        const out = { items: {}, confusions: {} };
        if (!remote) remote = { settings: null, bests: {}, days: {}, items: {}, confusions: {} };
        let win = Object.assign(synced(ls), { upd: ls.upd || 0 });
        if (ls.by) win.by = ls.by;
        if (remote.settings && remoteWins(win, remote.settings, localDev)) win = Object.assign({}, remote.settings);
        out.settings = Object.assign(localOnly(ls), win, { played: mergePlayed(ls.played, remote.played) });
        if (!win.by) delete out.settings.by;
        out.bests = mergeBests(local.bests || {}, remote.bests);
        out.days = mergeDays(local.days || {}, remote.days);
        for (const d of DECKS) {
            out.items[d] = mergeMap((local.items || {})[d] || {}, (remote.items || {})[d], localDev);
            out.confusions[d] = mergeMap((local.confusions || {})[d] || {}, (remote.confusions || {})[d], localDev);
        }
        // remote.played is carried in settings.played; keep it on the state for a second merge
        out.played = out.settings.played;
        return out;
    }

    // ------------------------------------------------------------------ pack / unpack
    function packSettings(st, dev) {
        const s = st.settings || {};
        const sv = sortObj(Object.assign(synced(s), { upd: s.upd || 0, by: s.by || dev }));
        return JSON.stringify({ v: V, s: sv, played: normPlayed(s.played), bests: sortObj(st.bests), days: sortObj(st.days) });
    }
    function packDeck(items, conf, dev) {
        const devs = [];
        const ix = by => { const id = by || dev; let i = devs.indexOf(id); if (i < 0) { devs.push(id); i = devs.length - 1; } return i; };
        // device list in a fixed order, so the same data always gives the same text
        Object.keys(items || {}).forEach(k => ix(items[k].by)); Object.keys(conf || {}).forEach(k => ix(conf[k].by));
        devs.sort();
        const it = {}, cf = {};
        for (const k of Object.keys(items || {}).sort()) it[k] = encItem(items[k], devs.indexOf(items[k].by || dev));
        for (const k of Object.keys(conf || {}).sort()) cf[k] = Object.assign({}, conf[k], { by: conf[k].by || dev });
        return JSON.stringify({ v: V, devs, items: it, conf: cf });
    }
    // decks: { doc name: text } (a sharded deck gives one text per doc)
    function packAll(state, dev) {
        const decks = {};
        for (const d of DECKS) {
            const n = SHARDS[d] || 1, items = state.items[d] || {}, conf = state.confusions[d] || {};
            if (n === 1) { decks[deckDoc(d)] = packDeck(items, conf, dev); continue; }
            const its = Array.from({ length: n }, () => ({})), cfs = Array.from({ length: n }, () => ({}));
            for (const k in items) its[shardOf(k, n)][k] = items[k];
            for (const k in conf) cfs[confShard(k, conf[k], n)][k] = conf[k];
            for (let i = 0; i < n; i++) decks[shardDoc(d, i)] = packDeck(its[i], cfs[i], dev);
        }
        return { settings: packSettings(state, dev), decks };
    }
    function parse(doc, name) {
        if (!doc) return null;
        if (typeof doc.v === 'number' && doc.v > V) throw new SyncError('version', 'Your cloud progress was saved by a newer version of Kanji Match. Reload the page to update.');
        if (doc.d === undefined) return null;
        let o;
        try { o = JSON.parse(doc.d); } catch (e) { throw new SyncError('damaged', `The cloud copy of "${name}" is damaged; nothing was changed.`); }
        if (o && typeof o.v === 'number' && o.v > V) throw new SyncError('version', 'Your cloud progress was saved by a newer version of Kanji Match. Reload the page to update.');
        return o;
    }
    // raw: { meta, settings, 'deck-…': doc data | null }
    function unpack(raw) {
        parse(raw.meta, 'meta');
        const st = parse(raw.settings, 'settings') || {};
        const out = { settings: st.s || null, played: st.played || {}, bests: st.bests || {}, days: st.days || {},
                      items: {}, confusions: {} };
        for (const d of DECKS) {
            const items = {}, conf = {};
            for (const name of deckDocs(d)) {
                const o = parse(raw[name], name) || {};
                const devs = o.devs || [];
                for (const k in o.items || {}) items[k] = decItem(o.items[k], devs);
                Object.assign(conf, o.conf || {});
            }
            out.items[d] = items;
            // R6: pair keys saved before the fix ('a|b') are repaired, so both sides use the same keys
            out.confusions[d] = Core.repairConfusions(conf).conf;
        }
        return out;
    }
    // A merged state used as the "remote" side of a second merge (settings.played lives on the state)
    const asRemote = m => ({ settings: (() => { const s = Object.assign({}, m.settings); LOCAL_ONLY.forEach(k => { if (k !== 'upd' && k !== 'by') delete s[k]; }); return s; })(),
                             played: m.settings.played, bests: m.bests, days: m.days, items: m.items, confusions: m.confusions });

    // ------------------------------------------------------------------ one sync
    // store: MatchStore instance (load, applySync). Returns { wrote: [doc names], sizes, localChanged }.
    async function sync({ adapter, store, deviceId, now }) {
        const local = await store.load();
        let plan = null;
        await adapter.runTransaction(async tx => {
            const names = ['meta', 'settings'].concat(docNames());
            const raw = {};
            for (const n of names) raw[n] = await tx.get(n);
            const remote = unpack(raw);
            const merged = merge(local, remote, deviceId);
            const out = packAll(merged, deviceId);
            const sizes = { settings: out.settings.length };
            const writes = [];
            if (!raw.settings || raw.settings.d !== out.settings) writes.push(['settings', out.settings]);
            for (const n of docNames()) {
                sizes[n] = out.decks[n].length;
                const r = raw[n];
                if (!r || r.d !== out.decks[n]) writes.push([n, out.decks[n]]);
            }
            for (const [n, d] of writes) {
                if (d.length > MAX_CHARS) throw new SyncError('size', `Progress for ${n.replace('deck-', '')} is too large to sync (${d.length.toLocaleString('en')} characters; the limit is ${MAX_CHARS.toLocaleString('en')}). It is still saved in this browser.`, { doc: n, size: d.length });
            }
            if (writes.length) {
                for (const [n, d] of writes) tx.set(n, { v: V, mt: now, d });
                tx.set('meta', { v: V, mt: now });
            }
            plan = { merged, wrote: writes.map(w => w[0]), sizes };
        });
        // Fold the merged data into what is saved now (a board may have finished during the transaction).
        const localChanged = await store.applySync(cur => merge(cur, asRemote(plan.merged), deviceId));
        return Object.assign(plan, { localChanged });
    }

    // ------------------------------------------------------------------ controller
    // Triggers: sign-in (incl. a remembered sign-in at start-up), page hide, after each board (debounced),
    // settings changes (debounced). A failed sync leaves local data as it was and retries later.
    // guard (decision 14, optional): { lastUid(), setLastUid(uid), hasLocal(): Promise<bool>,
    //   ask(user): Promise<'merge'|'replace'|'cancel'>, replaceLocal(): Promise } — when a different account
    // than the last one signs in and this browser has progress, nothing syncs until the user has chosen.
    function controller({ cloud, store, onStatus, onApplied, guard, debounceMs = 4000, retryMinMs = 30000, retryMaxMs = 300000,
                          clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
        let user = null, subscribed = null, running = null, queued = null, dirty = false, holding = false;
        let timer = null, retryTimer = null, retryMs = 0, status = { state: 'signed-out', user: null };
        const set = s => { status = Object.assign({ user }, s); if (onStatus) onStatus(status); };
        const clear = () => { if (timer) clearTimer(timer); if (retryTimer) clearTimer(retryTimer); timer = retryTimer = null; };
        function retryLater(fn) {
            retryMs = retryMs ? Math.min(retryMaxMs, retryMs * 2) : retryMinMs;
            if (retryTimer) clearTimer(retryTimer);
            retryTimer = setTimer(() => { retryTimer = null; fn(); }, retryMs);
        }
        function subscribe() {
            if (!subscribed) {
                subscribed = Promise.resolve(cloud.onUser(u => {
                    const prev = user; user = u;
                    if (!u) { clear(); set({ state: 'signed-out' }); return; }
                    if (!prev || prev.uid !== u.uid) newUser(u);
                })).catch(e => { subscribed = null; throw e; });
            }
            return subscribed;
        }
        async function newUser(u) {
            if (guard) {
                holding = true;
                try {
                    const last = guard.lastUid();
                    if (last && last !== u.uid && await guard.hasLocal()) {
                        set({ state: 'confirm' });
                        const c = await guard.ask(u);
                        if (user !== u) return;
                        if (c === 'cancel') { holding = false; await signOut(); return; }
                        if (c === 'replace') await guard.replaceLocal();
                    }
                    guard.setLastUid(u.uid);
                } finally { holding = false; }
                if (user !== u) return;
            }
            return syncNow('sign-in');
        }
        async function start() {
            if (!cloud.remembered()) { set({ state: 'signed-out' }); return; }
            set({ state: 'loading' });
            try { await subscribe(); } catch (e) { set({ state: 'offline', message: e.message }); retryLater(start); }
        }
        async function signIn() {
            set({ state: 'loading' });
            try { await subscribe(); await cloud.signIn(); } catch (e) {
                set({ state: user ? status.state : 'signed-out', message: friendly(e) });
            }
        }
        async function signOut() {
            clear();
            try { await cloud.signOut(); } finally { user = null; set({ state: 'signed-out' }); }
        }
        function friendly(e) {
            const c = (e && e.code) || '';
            if (/popup-closed|cancelled-popup/.test(c)) return 'Sign-in was cancelled.';
            if (/popup-blocked/.test(c)) return 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.';
            if (/network/.test(c)) return "Couldn't reach Google. Check the connection and try again.";
            return (e && e.message) || 'Sign-in failed.';
        }
        function syncNow() {
            if (!user || holding) return Promise.resolve(null);
            // one sync at a time; a request during a sync runs once right after it
            if (running) { if (!queued) queued = running.then(() => { queued = null; return syncNow(); }); return queued; }
            if (timer) { clearTimer(timer); timer = null; }
            const uid = user.uid;
            dirty = false;
            set({ state: 'syncing', at: status.at });
            running = (async () => {
                try {
                    const deviceId = (await store.load()).meta.deviceId;
                    const r = await sync({ adapter: cloud.adapter(uid), store, deviceId, now: clock() });
                    retryMs = 0;
                    if (user && user.uid === uid) set({ state: 'synced', at: clock(), sizes: r.sizes });
                    if (r.localChanged && onApplied) await onApplied(r);
                    return r;
                } catch (e) {
                    dirty = true;
                    if (e && (e.code === 'size' || e.code === 'version' || e.code === 'damaged')) set({ state: 'error', message: e.message, at: status.at });
                    else { set({ state: 'offline', message: e && e.message, at: status.at }); retryLater(syncNow); }
                    return null;
                } finally {
                    running = null;
                }
            })();
            return running;
        }
        function later() {
            dirty = true;
            if (!user) return;
            if (timer) clearTimer(timer);
            timer = setTimer(() => { timer = null; syncNow(); }, debounceMs);
        }
        return {
            start, signIn, signOut, syncNow,
            boardDone: later, settingsChanged: later,
            hidden() { if (user && dirty) syncNow(); },
            online() { if (user && (status.state === 'offline' || dirty)) syncNow(); },
            status: () => status, user: () => user,
        };
    }

    return { V, MAX_CHARS, DECKS, SHARDS, deckDocs, docNames, shardOf, SyncError, encItem, decItem, remoteWins, mergeMap, mergeBests, mergeDays, mergePlayed,
             merge, packSettings, packDeck, packAll, unpack, sync, controller, dn, ds };
}));
