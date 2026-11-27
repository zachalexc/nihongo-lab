// Round 10: deck D (look-alike word ↔ meaning), match-plan decisions 22–26.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../match_core.js');
const S = require('../match_store.js');
const Y = require('../match_sync.js');

const DATA = path.join(__dirname, '..', 'data');
const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const meta = load('meta.json');
const synIdx = C.synonymIndex(meta.synonyms);
const L = {}; C.LEVEL_ORDER.forEach(lv => { L[lv] = load(meta.lookalikes[lv].file).items; });
const W = {}; C.LEVEL_ORDER.forEach(lv => { W[lv] = load(meta.words[lv].file).items; });
const K = {}; C.LEVEL_ORDER.forEach(lv => load(meta.levels[lv].file).items.forEach(it => { K[it.k] = lv; }));
const all = C.LEVEL_ORDER.flatMap(lv => L[lv]);
const rank = lv => C.LEVEL_ORDER.indexOf(lv);
const lpOf = k => new Set(all.filter(it => it.kanji.includes(k)).flatMap(it => it.lp));
const pair = (a, b) => lpOf(a).has(b) || lpOf(b).has(a);

test('Look-alikes data: KRADFILE source recorded, one card per word with a partner, ids and levels', () => {
    assert.match(meta.sources.kradfile.sha256, /^[0-9a-f]{64}$/);
    for (const lv of C.LEVEL_ORDER) {
        assert.equal(meta.lookalikes[lv].count, L[lv].length);
        const words = new Map(W[lv].map(w => [w.id, w]));
        L[lv].forEach(it => {
            const w = words.get(it.wid);
            assert.ok(w, it.id); assert.equal(it.id, 'd:' + w.k + '|' + w.r); assert.equal(it.lv, lv);
            assert.ok(it.lp.length > 0 && it.lk.length > 0, it.id);
            assert.ok(it.g && it.shown[0] === C.norm(it.g) && it.keys.includes('#' + it.k), it.id);
        });
        console.log(`  ${lv}: ${W[lv].length} words → ${L[lv].length} Look-alikes cards`);
    }
});

test('look-alike rule: score pairs, containment (大/犬, 木/本), tsv + and −', () => {
    for (const [a, b] of ['未末', '待持', '青晴', '半判']) assert.ok(pair(a, b), a + b + ' (score)');
    for (const [a, b] of ['大犬', '木本', '王玉']) assert.ok(pair(a, b), a + b + ' (containment)');
    for (const [a, b] of ['土士', '人入', '日目', '自白', '問間']) assert.ok(pair(a, b), a + b + ' (tsv +)');
    for (const [a, b] of ['上与', '万不', '外多', '追速']) assert.ok(!pair(a, b), a + b + ' (tsv −)');
});

test('decision 24: a card at level L only uses partners at level ≤ L, never its own kanji', () => {
    for (const it of all) it.lp.forEach(k => {
        assert.ok(rank(K[k]) <= rank(it.lv), `${it.id} partner ${k} (${K[k]})`);
        assert.ok(!it.kanji.includes(k));
    });
    L.N5.forEach(it => it.lp.forEach(k => assert.equal(K[k], 'N5')));
});

test('clash: same meaning or the same word never share a board', () => {
    const a = { id: 'd:例|れい', shown: ['example'], keys: ['#例', 'example'] }, b = { id: 'd:実例|じつれい', shown: ['example'], keys: ['#実例', 'example'] };
    assert.ok(C.clash(a, b, synIdx));
    const c = { id: 'd:人|じん', shown: ['-ian', '#人'], keys: ['#人', '-ian'] }, d = { id: 'd:人|ひと', shown: ['person', '#人'], keys: ['#人', 'person'] };
    assert.ok(C.clash(c, d, synIdx), 'same spelling, two readings: once per board');
    all.forEach(it => assert.ok(it.shown.includes('#' + it.k) && it.keys.includes('#' + it.k), it.id));
});

for (const lv of C.LEVEL_ORDER) {
    test(`Look-alikes boards fill at ${lv}, clash-free, grouped (decision 26)`, () => {
        const pool = L[lv], byId = new Map(pool.map(it => [it.id, it]));
        const states = {}; let recent = [], short = 0;
        const shares = [];
        for (let i = 0; i < 20; i++) {
            const b = C.buildBoard({ pool, states, confusions: {}, size: 12, mode: 'play', recent, today: '2026-11-26', seed: 21 + i, synIdx, lookalike: true });
            if (b.ids.length < 12) short++;
            const its = b.ids.map(id => byId.get(id));
            for (let x = 0; x < its.length; x++) for (let y = x + 1; y < its.length; y++) {
                assert.ok(!C.clash(its[x], its[y], synIdx), `${its[x].k} / ${its[y].k}`);
                assert.notEqual(its[x].k, its[y].k, 'word once per board');
            }
            shares.push(C.groupShare(b.ids, byId));
            b.ids.forEach(id => { states[id] = states[id] || { box: 2, due: '2026-11-29', seen: 1, misses: 0, lapses: 0, lastSeen: i, lastGrade: 2, upd: i }; });
            recent = [b.ids].concat(recent).slice(0, 3);
        }
        const qs = [];
        for (let i = 0; i < 10; i++) {
            const q = C.buildBoard({ pool, states: {}, confusions: {}, size: 6, mode: 'play', recent: [], today: '2026-11-26', seed: 3 + i, synIdx, lookalike: true });
            assert.equal(q.ids.length, 6); qs.push(C.groupShare(q.ids, byId));
        }
        const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
        console.log(`  ${lv}: group share Full min ${Math.min(...shares)} avg ${avg(shares)} / 12; Quick min ${Math.min(...qs)} avg ${avg(qs)} / 6`);
        assert.equal(short, 0);
        if (['N4', 'N3', 'N2', 'N1'].includes(lv)) assert.ok(Math.min(...shares) >= 6, `${lv} share ${Math.min(...shares)}`);
    });
}

test('Look-alikes progress is its own deck: saved, exported and synced as deck-word-lookalike (size reported)', async () => {
    assert.ok(Y.DECKS.includes('word-lookalike'));
    assert.deepEqual(Y.deckDocs('word-lookalike'), ['deck-word-lookalike']);
    const s = S.memory();
    await s.saveBoard({ deck: 'word-lookalike', items: { 'd:待つ|まつ': { box: 2, upd: 5 } }, confusions: {}, bests: {} });
    const d = await s.load();
    assert.equal(d.items['word-lookalike']['d:待つ|まつ'].box, 2);
    assert.deepEqual(d.items['kanji-meaning'], {});
    assert.ok((await s.exportAll()).decks['word-lookalike'].items['d:待つ|まつ']);
    const items = {}; let t = 1764100000000;
    all.forEach(it => { items[it.id] = { box: 5, due: '2027-03-14', seen: 23, misses: 7, lapses: 2, weakShows: 6, weakRun: 0,
        unsureDays: ['2026-12-01', '2026-12-09'], today: { day: '2027-01-20', weakShows: 1 }, lastSeen: t - 3, lastGrade: 2, upd: t += 997 }; });
    const conf = {};
    all.slice(0, 300).forEach((it, i) => { const b = all[(i + 5) % all.length].id; conf[C.pairKey(it.id, b)] = { a: it.id < b ? it.id : b, b: it.id < b ? b : it.id, count: 3, lastDay: '2027-01-20', cleanDays: [], upd: i }; });
    const out = Y.packAll({ settings: {}, bests: {}, days: {}, items: { 'word-lookalike': items }, confusions: { 'word-lookalike': conf } }, '7f3c2a10-1234-4abc-9def-0123456789ab');
    const doc = out.decks['deck-word-lookalike'];
    console.log(`  Look-alikes deck: ${all.length} items + 300 pairs → ${doc.length} characters, ${Buffer.byteLength(doc, 'utf8')} bytes`);
    assert.ok(Buffer.byteLength(doc, 'utf8') < Y.MAX_CHARS * 0.9);
    const back = Y.unpack({ 'deck-word-lookalike': { v: 1, mt: 1, d: doc } });
    assert.equal(Object.keys(back.items['word-lookalike']).length, all.length);
});
