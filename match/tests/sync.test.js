// R5: sign-in and sync (match-plan decision 10) against a fake Firestore (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../match_core.js');
const S = require('../match_store.js');
const Y = require('../match_sync.js');
const cloudFactory = require('../match_cloud.js');

const KM = 'kanji-meaning', WR = 'word-reading';
const DOC_RE = /^(meta|settings|deck-[a-z-]+)$/;

// ---------------------------------------------------------------- fake backend (users/{uid}/match/{doc})
function server() { return { docs: new Map(), version: 0, reads: 0, writes: 0, offline: false, onTx: null }; }
function fakeCloud(srv, account = { uid: 'u1', email: 'zach@example.com' }) {
    let user = null; const cbs = [];
    const emit = () => cbs.forEach(cb => cb(user));
    return {
        signIn() { user = account; emit(); return user; },
        signOut() { user = null; emit(); },
        onUser(cb) { cbs.push(cb); cb(user); },
        adapter(uid) {
            return { async runTransaction(fn) {
                if (srv.offline) throw Object.assign(new Error('Failed to fetch'), { code: 'unavailable' });
                for (let attempt = 0; attempt < 5; attempt++) {
                    const v0 = srv.version, pending = new Map();
                    const tx = {
                        async get(n) { srv.reads++; const d = srv.docs.get(uid + '/' + n); return d ? JSON.parse(JSON.stringify(d)) : null; },
                        set(n, d) { pending.set(n, d); },
                    };
                    const r = await fn(tx);
                    if (srv.onTx) { const f = srv.onTx; srv.onTx = null; await f(); }
                    if (srv.offline) throw Object.assign(new Error('Failed to fetch'), { code: 'unavailable' });
                    if (srv.version !== v0) continue;       // someone wrote meanwhile: retry, like Firestore
                    for (const [n, d] of pending) {         // the same checks as firestore.rules
                        assert.match(n, DOC_RE);
                        assert.ok(Object.keys(d).every(k => ['v', 'mt', 'd'].includes(k)));
                        if ('d' in d) { assert.equal(typeof d.d, 'string'); assert.ok(d.d.length <= 900000); }
                        srv.docs.set(uid + '/' + n, d); srv.writes++;
                    }
                    if (pending.size) srv.version++;
                    return r;
                }
                throw new Error('too much contention');
            } };
        },
    };
}
function device(srv, opts = {}) {
    const storage = S.memoryStorage();
    const created = [];
    const win = { localStorage: storage, __matchCloudFake: opts.noFake ? undefined : fakeCloud(srv, opts.account),
                  document: { baseURI: 'http://localhost/match/', head: { appendChild() {} },
                              createElement: t => { created.push(t); return {}; } } };
    const cloud = cloudFactory(win);
    const store = S.create(storage);
    const timers = [];
    const ctl = Y.controller({ cloud, store, debounceMs: 10, onApplied: opts.onApplied,
                               setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimer: () => {} });
    return { storage, store, cloud, ctl, win, created, timers };
}
const state = (box, upd, extra) => Object.assign({ box, due: '2026-11-27', seen: 3, misses: 1, lapses: 0, weakShows: 0, weakRun: 0,
    unsureDays: [], today: { day: '2026-11-26', weakShows: 0 }, lastSeen: upd, lastGrade: 2, upd }, extra || {});
async function seed(store, deck, items, more = {}) {
    await store.saveBoard({ deck, items, confusions: more.confusions || {}, bests: more.bests || {},
                            day: more.day || { key: '2026-11-26', boards: 1, misses: 0, activeMs: 1000 },
                            result: { id: 'b' + Math.random(), schema: 1, misses: 0 } });
    if (more.settings) await store.saveSettings(more.settings);
}
const remoteOf = (srv, uid = 'u1') => {
    const raw = {}; for (const n of ['meta', 'settings', 'deck-' + KM, 'deck-' + WR]) raw[n] = srv.docs.get(uid + '/' + n) || null;
    return Y.unpack(raw);
};
const strip = m => { const o = {}; for (const k in m) { o[k] = Object.assign({}, m[k]); delete o[k].by; } return o; };

// ---------------------------------------------------------------- encoding
test('item states survive the compact encoding exactly', () => {
    let s = null;
    const grades = [2, 1, 0, 1, 1, 2];
    grades.forEach((g, i) => { s = C.applyGrade(s, g, '2026-11-' + (10 + i), 1764000000000 + i * 1000, {}); });
    s.lastSeen -= 5;                  // lastSeen ≠ upd still round-trips
    s.future = { x: 1 };              // unknown fields are kept
    const back = Y.decItem(JSON.parse(JSON.stringify(Y.encItem(s, 0))), ['dev-a']);
    assert.equal(back.by, 'dev-a'); delete back.by;
    assert.deepEqual(back, s);
    assert.equal(Y.ds(Y.dn('2025-12-31')), '2025-12-31');
});

// ---------------------------------------------------------------- merge rules
test('item states: latest upd wins; a tie goes to the higher device id', () => {
    const l = { a: state(2, 100), b: state(3, 300), t: state(4, 500) };
    const r = { a: state(5, 200, { by: 'dev-b' }), b: state(1, 200, { by: 'dev-b' }), c: state(1, 50, { by: 'dev-b' }),
                t: state(1, 500, { by: 'dev-z' }) };
    const m = Y.mergeMap(l, r, 'dev-m');
    assert.equal(m.a.box, 5); assert.equal(m.b.box, 3); assert.equal(m.c.box, 1);
    assert.equal(m.t.box, 1, 'dev-z > dev-m');
    assert.equal(Y.mergeMap(l, { t: state(1, 500, { by: 'dev-a' }) }, 'dev-m').t.box, 4, 'dev-a < dev-m: local kept');
});

test('confusions: core stamps upd on changed pairs; latest upd wins', () => {
    const rec = { ids: ['k:人', 'k:入'], wrongPairs: [{ k: 'k:人', a: 'k:入' }], abandoned: false };
    const c1 = C.updateConfusions({}, rec, {}, '2026-11-26', 111);
    const key = C.pairKey('k:人', 'k:入');
    assert.equal(c1[key].upd, 111);
    const old = Object.assign({}, c1[key], { count: 5, upd: 50, by: 'dev-b' });
    assert.equal(Y.mergeMap(c1, { [key]: old }, 'dev-a')[key].count, 1);
    assert.equal(Y.mergeMap({ [key]: old }, c1, 'dev-a')[key].count, 1);
    // a local change clears `by` (only kept for tie-breaks)
    const c2 = C.updateConfusions({ [key]: old }, rec, {}, '2026-11-27', 222);
    assert.equal(c2[key].upd, 222); assert.equal(c2[key].by, undefined);
    const r = C.applyBoard({ record: { size: 2, ids: ['k:人'], matches: [], wrongPairs: [], abandoned: false },
                             states: { 'k:人': state(2, 10, { by: 'dev-b' }) }, confusions: {}, today: '2026-11-27', now: 333 });
    if (r.changed['k:人']) assert.equal(r.changed['k:人'].by, undefined);
});

test('bests: best per key; days: union; played: union; settings: latest upd, device-only fields stay', () => {
    const b = Y.mergeBests({ x: { misses: 1, activeMs: 9 }, y: { misses: 0, activeMs: 50 } },
                           { x: { misses: 0, activeMs: 99 }, y: { misses: 0, activeMs: 40 }, z: { misses: 3, activeMs: 1 } });
    assert.deepEqual(b, { x: { misses: 0, activeMs: 99 }, y: { misses: 0, activeMs: 40 }, z: { misses: 3, activeMs: 1 } });
    const d = Y.mergeDays({ '2026-11-25': { boards: 2, misses: 1, activeMs: 10 }, '2026-11-26': { boards: 1, misses: 4, activeMs: 5 } },
                          { '2026-11-26': { boards: 3, misses: 0, activeMs: 9 }, '2026-11-24': { boards: 1, misses: 0, activeMs: 1 } });
    assert.deepEqual(Object.keys(d).sort(), ['2026-11-24', '2026-11-25', '2026-11-26']);
    assert.deepEqual(d['2026-11-26'], { boards: 3, misses: 4, activeMs: 9 });
    assert.deepEqual(Y.mergePlayed({ [KM]: ['N4', 'N5'] }, { [KM]: ['N3', 'N5'], [WR]: ['N5'] }), { [KM]: ['N5', 'N4', 'N3'], [WR]: ['N5'] });

    const local = { settings: { level: 'N4', size: 12, upd: 100, persistAsked: true, iosTipDismissed: false, played: { [KM]: ['N4'] } } };
    const newer = Y.merge(local, { settings: { level: 'N2', size: 6, upd: 200, by: 'dev-b' }, played: { [KM]: ['N2'] } }, 'dev-a');
    assert.equal(newer.settings.level, 'N2'); assert.equal(newer.settings.size, 6);
    assert.equal(newer.settings.persistAsked, true, 'device-only field kept');
    assert.deepEqual(newer.settings.played, { [KM]: ['N4', 'N2'] });
    const older = Y.merge(local, { settings: { level: 'N2', upd: 50, by: 'dev-b', iosTipDismissed: true } }, 'dev-a');
    assert.equal(older.settings.level, 'N4'); assert.equal(older.settings.iosTipDismissed, false);
});

// ---------------------------------------------------------------- whole syncs
test('first sign-in uploads local progress to an empty cloud; local data unchanged', async () => {
    const srv = server(), A = device(srv);
    await seed(A.store, KM, { 'k:人': state(3, 100), 'k:山': state(1, 120) }, { bests: { q: { misses: 0, activeMs: 5 } },
        settings: { level: 'N4', upd: 1, played: { [KM]: ['N5', 'N4'] } } });
    const before = S.stable(await A.store.load());
    await A.ctl.signIn();
    await A.ctl.syncNow();
    assert.equal(A.ctl.status().state, 'synced');
    const r = remoteOf(srv);
    assert.deepEqual(strip(r.items[KM]), (await A.store.load()).items[KM]);
    assert.equal(r.settings.level, 'N4');
    assert.deepEqual(r.bests, { q: { misses: 0, activeMs: 5 } });
    assert.equal(S.stable(await A.store.load()), before, 'local untouched');
    assert.equal((await A.store.load()).log.length, 1, 'log stays local');
    assert.ok(!srv.docs.get('u1/settings').d.includes('"log"'));
    // a second sync with nothing new reads 4 docs and writes nothing
    const w = srv.writes; await A.ctl.syncNow(); assert.equal(srv.writes, w);
});

test('two devices: different items merge; the same item keeps the latest change', async () => {
    const srv = server(), A = device(srv), B = device(srv);
    await seed(A.store, KM, { 'k:人': state(2, 100), 'k:山': state(3, 150) });
    await seed(B.store, KM, { 'k:人': state(5, 200), 'k:川': state(1, 90) });
    await seed(B.store, WR, { 'w:人|ひと': state(2, 95) });
    await A.ctl.signIn(); await A.ctl.syncNow();
    await B.ctl.signIn(); await B.ctl.syncNow();
    await A.ctl.syncNow();
    const a = await A.store.load(), b = await B.store.load();
    for (const s of [a, b]) {
        assert.deepEqual(Object.keys(s.items[KM]).sort(), ['k:人', 'k:山', 'k:川']);
        assert.equal(s.items[KM]['k:人'].box, 5);
        assert.equal(s.items[WR]['w:人|ひと'].box, 2);
    }
    assert.equal(S.stable(strip(a.items[KM])), S.stable(strip(b.items[KM])));
    // days: A saved 1 board on 11/26, B 2 → the larger count of each field
    assert.equal(a.days['2026-11-26'].boards, 2); assert.equal(b.days['2026-11-26'].boards, 2);
    // B changes k:山 later, A changes k:川 later: both land everywhere
    await seed(B.store, KM, Object.assign({}, b.items[KM], { 'k:山': state(4, 400) }));
    await seed(A.store, KM, Object.assign({}, a.items[KM], { 'k:川': state(3, 410) }));
    await B.ctl.syncNow(); await A.ctl.syncNow(); await B.ctl.syncNow();
    for (const D of [A, B]) {
        const s = (await D.store.load()).items[KM];
        assert.equal(s['k:山'].box, 4); assert.equal(s['k:川'].box, 3); assert.equal(s['k:人'].box, 5);
    }
});

test('a board saved during a sync is kept', async () => {
    const srv = server(), A = device(srv);
    await seed(A.store, KM, { 'k:人': state(2, 100) });
    await A.ctl.signIn(); await A.ctl.syncNow();
    srv.onTx = async () => { const cur = (await A.store.load()).items[KM];
                             await seed(A.store, KM, Object.assign({}, cur, { 'k:水': state(1, 999) })); };
    await A.ctl.syncNow();
    assert.equal((await A.store.load()).items[KM]['k:水'].box, 1);
    await A.ctl.syncNow();
    assert.equal(remoteOf(srv).items[KM]['k:水'].box, 1);
});

test('offline: nothing changes, status says so, a retry is set; back online it syncs', async () => {
    const srv = server(), A = device(srv);
    await seed(A.store, KM, { 'k:人': state(2, 100) });
    srv.offline = true;
    await A.ctl.signIn(); await A.ctl.syncNow();
    assert.equal(A.ctl.status().state, 'offline');
    assert.equal(srv.writes, 0);
    assert.equal((await A.store.load()).items[KM]['k:人'].box, 2);
    assert.ok(A.timers.some(t => t.ms === 30000), 'retry in 30 s');
    // lost connection in the middle of a transaction: also nothing written
    srv.offline = false; srv.onTx = async () => { srv.offline = true; };
    await A.ctl.syncNow();
    assert.equal(srv.writes, 0); assert.equal(A.ctl.status().state, 'offline');
    srv.offline = false;
    A.ctl.online(); await A.ctl.syncNow();
    assert.equal(A.ctl.status().state, 'synced');
    assert.equal(remoteOf(srv).items[KM]['k:人'].box, 2);
});

test('a damaged or newer cloud copy: no write, local untouched, error shown', async () => {
    const srv = server(), A = device(srv);
    await seed(A.store, KM, { 'k:人': state(2, 100) });
    srv.docs.set('u1/deck-' + KM, { v: 1, mt: 1, d: '{broken' });
    await A.ctl.signIn(); await A.ctl.syncNow();
    assert.equal(A.ctl.status().state, 'error'); assert.equal(srv.writes, 0);
    srv.docs.set('u1/deck-' + KM, { v: 2, mt: 1, d: '{}' });
    await A.ctl.syncNow();
    assert.match(A.ctl.status().message, /newer version/); assert.equal(srv.writes, 0);
    assert.equal((await A.store.load()).items[KM]['k:人'].box, 2);
});

test('sign-out keeps local data; signing in again syncs again', async () => {
    const srv = server(), A = device(srv);
    await seed(A.store, KM, { 'k:人': state(2, 100) });
    await A.ctl.signIn(); await A.ctl.syncNow();
    assert.equal(A.storage.getItem('nihongoMatch.cloud'), '1');
    await A.ctl.signOut();
    assert.equal(A.ctl.status().state, 'signed-out');
    assert.equal(A.storage.getItem('nihongoMatch.cloud'), null);
    assert.equal((await A.store.load()).items[KM]['k:人'].box, 2);
    await A.ctl.syncNow(); assert.equal(A.ctl.status().state, 'signed-out', 'no sync while signed out');
});

test('signed out: start-up loads no Firebase code; a remembered sign-in does', async () => {
    const srv = server();
    const D = device(srv, { noFake: true });
    let imported = 0;
    D.win.document.createElement = () => { imported++; return {}; };
    await D.ctl.start();
    assert.equal(D.ctl.status().state, 'signed-out');
    assert.equal(imported, 0); assert.equal(D.cloud.loaded(), false);
    // Endless's flag counts too (same Google sign-in), Match's own flag of course
    D.storage.setItem('nlCloud', '1'); assert.equal(D.cloud.remembered(), true);
    D.storage.removeItem('nlCloud'); D.storage.setItem('nihongoMatch.cloud', '1'); assert.equal(D.cloud.remembered(), true);
    // and the page itself has no static reference to the SDK
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(!/firebase/i.test(html));
    // with the fake, a remembered user syncs at start-up
    const E = device(srv); E.storage.setItem('nihongoMatch.cloud', '1');
    E.win.__matchCloudFake.signIn();
    await E.ctl.start(); await E.ctl.syncNow();
    assert.equal(E.ctl.status().state, 'synced');
});

test('after a board, sync is debounced; hiding the page syncs only when something changed', async () => {
    const srv = server(), A = device(srv);
    await A.ctl.signIn(); await A.ctl.syncNow();
    const w = srv.reads;
    A.ctl.hidden(); await A.ctl.syncNow();       // nothing dirty: the explicit sync only
    const n = A.timers.length;
    A.ctl.boardDone(); A.ctl.boardDone();
    assert.equal(A.timers.length, n + 2); assert.equal(A.timers[n].ms, 10);
    await seed(A.store, KM, { 'k:人': state(2, 100) });
    A.timers[n + 1].f(); await A.ctl.syncNow();
    assert.equal(remoteOf(srv).items[KM]['k:人'].box, 2);
    assert.ok(srv.reads > w);
});

// ---------------------------------------------------------------- size
function fullWordsDeck() {
    const dir = path.join(__dirname, '..', 'data');
    const items = {};
    let t = 1764100000000;
    for (const f of fs.readdirSync(dir).filter(f => /^words_.*\.json$/.test(f))) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const it of (Array.isArray(d) ? d : d.items)) {
            // a well-worn state: box 5, two unsure days, lapses, today's counter
            items[it.id] = state(5, t += 997, { due: '2027-03-14', seen: 23, misses: 7, lapses: 2, weakShows: 6, weakRun: 0,
                unsureDays: ['2026-12-01', '2026-12-09'], today: { day: '2027-01-20', weakShows: 1 }, lastSeen: t - 3 });
        }
    }
    return items;
}
test('a fully seen Words deck fits a deck doc (size reported)', () => {
    const items = fullWordsDeck();
    const conf = {};
    Object.keys(items).slice(0, 300).forEach((id, i, a) => {
        const b = a[(i + 1) % a.length];
        conf[C.pairKey(id, b)] = { a: id, b, count: 3, lastDay: '2027-01-20', cleanDays: ['2027-01-21'], upd: 1764100000000 + i };
    });
    const d = Y.packDeck(items, conf, '7f3c2a10-1234-4abc-9def-0123456789ab');
    const bytes = Buffer.byteLength(d, 'utf8');
    console.log(`  Words deck: ${Object.keys(items).length} items + 300 pairs → ${d.length} characters, ${bytes} bytes`);
    assert.ok(d.length < Y.MAX_CHARS); assert.ok(bytes < 1000000, 'under Firestore’s 1 MiB doc limit');
    const back = Y.unpack({ ['deck-' + WR]: { v: 1, mt: 1, d } });
    assert.equal(Object.keys(back.items[WR]).length, Object.keys(items).length);
});

test('a deck doc over 900,000 characters is refused: no write at all, local kept, error shown', async () => {
    const srv = server(), A = device(srv);
    const items = {};
    for (let i = 0; i < 9000; i++) items['k:' + i] = state(2, 100 + i, { pad: 'x'.repeat(80) });
    await seed(A.store, KM, items);
    await A.ctl.signIn(); await A.ctl.syncNow();
    assert.equal(A.ctl.status().state, 'error');
    assert.match(A.ctl.status().message, /too large/);
    assert.equal(srv.writes, 0);
    assert.equal(Object.keys((await A.store.load()).items[KM]).length, 9000);
});
