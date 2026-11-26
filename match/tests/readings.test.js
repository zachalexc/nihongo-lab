// Round 7: deck A (kanji ↔ readings), match-plan decision 2.
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
const R = {}; C.LEVEL_ORDER.forEach(lv => { R[lv] = load(meta.readings[lv].file).items; });
const K = {}; C.LEVEL_ORDER.forEach(lv => { K[lv] = load(meta.levels[lv].file).items; });
const all = C.LEVEL_ORDER.flatMap(lv => R[lv]);
const byK = new Map(all.map(it => [it.k, it]));
const isKata = s => /^[ァ-ヶー]+$/.test(s);
const hira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const stem = k => k.split('(')[0];

test('one Readings card per kanji, same levels as Meaning, own ids', () => {
    for (const lv of C.LEVEL_ORDER) {
        assert.deepEqual(R[lv].map(it => it.k), K[lv].map(it => it.k), lv);
        R[lv].forEach(it => { assert.equal(it.id, 'r:' + it.k); assert.equal(it.lv, lv); });
        assert.equal(meta.readings[lv].count, R[lv].length);
    }
});

test('cap 2 on + 3 kun (one kun per stem), on first, ordered by use in the word data, ties in data order', () => {
    for (const it of all) {
        const on = it.rd.filter(isKata), kun = it.rd.filter(r => !isKata(r));
        assert.ok(it.rd.length > 0, it.k);
        assert.deepEqual(it.rd, on.concat(kun), it.k + ' on first');
        assert.ok(on.length <= 2 && kun.length <= 3, it.k);
        on.forEach(r => assert.ok(it.on.includes(r))); kun.forEach(r => assert.ok(it.kun.includes(r)));
        assert.equal(new Set(kun.map(stem)).size, kun.length, it.k + ' one kun per stem');
        assert.equal(on.length, Math.min(2, it.on.length), it.k);
        const u = x => it.use[x] || 0;
        // order by use, ties by data order
        const ok = (list, src) => list.every((x, i) => i === 0 || u(list[i - 1]) > u(x) || (u(list[i - 1]) === u(x) && src.indexOf(list[i - 1]) < src.indexOf(x)));
        assert.ok(ok(on, it.on), it.k); assert.ok(ok(kun, it.kun), it.k);
        // nothing left out that is used more than something shown
        const minOn = Math.min(...on.map(u)); it.on.filter(x => !on.includes(x)).forEach(x => assert.ok(u(x) <= minOn, it.k + ' ' + x));
        // shown = hiragana, okurigana dropped
        assert.deepEqual(it.shown, [...new Set(on.map(hira).concat(kun.map(stem)))], it.k);
        assert.deepEqual(it.keys, it.shown);
        assert.ok(it.ex.length <= 2);
    }
    assert.deepEqual(byK.get('休').rd, ['キュウ', 'やす(む)']);
    assert.deepEqual(byK.get('人').rd, ['ジン', 'ニン', 'ひと']);
    assert.deepEqual(byK.get('上').rd.slice(0, 2), ['ジョウ', 'ショウ']);
    const noUse = all.filter(it => !Object.keys(it.use).length);
    noUse.forEach(it => assert.deepEqual(it.rd.filter(isKata), it.on.slice(0, 2), it.k + ' no use: first readings'));
    console.log(`  Readings: ${all.length} cards; ${noUse.length} kanji have no word use (first readings kept)`);
});

test('clash: any shared reading (hiragana, okurigana dropped) keeps two kanji off one board', () => {
    const [a, b, c] = ['日', '火', '山'].map(k => byK.get(k));   // ニチ/ジツ/ひ · カ/ひ · サン/やま
    assert.ok(a.shown.includes('ひ') && b.shown.includes('ひ'));
    assert.ok(C.clash(a, b, synIdx)); assert.ok(!C.clash(a, c, synIdx));
    const [x, y] = ['人', '神'].map(k => byK.get(k));         // ジン in both (on, katakana → じん)
    assert.ok(C.clash(x, y, synIdx));
    const [p, q] = ['上', '揚'].map(k => byK.get(k));         // kun あ(げる) both → あ
    if (p.shown.includes('あ') && q.shown.includes('あ')) assert.ok(C.clash(p, q, synIdx));
});

// Board fill as in round 1: many boards from fresh progress, every board full and clash-free.
for (const lv of C.LEVEL_ORDER) {
    test(`Readings boards fill at ${lv}`, () => {
        const pool = R[lv], byId = new Map(pool.map(it => [it.id, it]));
        let states = {}, recent = [], short = 0, n = 0;
        const boards = lv === 'N5' ? 40 : 25;
        for (let i = 0; i < boards; i++) {
            const b = C.buildBoard({ pool, states, confusions: {}, size: 12, mode: 'play', recent, today: '2026-11-26', seed: 11 + i, synIdx });
            n++; if (b.ids.length < 12) short++;
            const its = b.ids.map(id => byId.get(id));
            for (let x = 0; x < its.length; x++) for (let y = x + 1; y < its.length; y++) assert.ok(!C.clash(its[x], its[y], synIdx), `${its[x].k} / ${its[y].k}`);
            b.ids.forEach(id => { states[id] = states[id] || { box: 2, due: '2026-11-29', seen: 1, misses: 0, lapses: 0, lastSeen: i, lastGrade: 2, upd: i }; });
            recent = [b.ids].concat(recent).slice(0, 3);
        }
        const q = C.buildBoard({ pool, states: {}, confusions: {}, size: 6, mode: 'play', recent: [], today: '2026-11-26', seed: 3, synIdx });
        console.log(`  ${lv}: ${pool.length} cards, ${n} boards of 12, ${short} short; Quick board ${q.ids.length}`);
        assert.equal(short, 0); assert.equal(q.ids.length, 6);
    });
}

test('Readings progress is its own deck: saved, exported and synced as deck-kanji-readings (size reported)', async () => {
    assert.ok(S.memory && Y.DECKS.includes('kanji-readings'));
    assert.deepEqual(Y.deckDocs('kanji-readings'), ['deck-kanji-readings']);
    const s = S.memory();
    await s.saveBoard({ deck: 'kanji-readings', items: { 'r:休': { box: 2, upd: 5 } }, confusions: {}, bests: {} });
    const d = await s.load();
    assert.equal(d.items['kanji-readings']['r:休'].box, 2);
    assert.deepEqual(d.items['kanji-meaning'], {});
    assert.ok((await s.exportAll()).decks['kanji-readings'].items['r:休']);
    // fully seen
    const items = {}; let t = 1764100000000;
    all.forEach(it => { items[it.id] = { box: 5, due: '2027-03-14', seen: 23, misses: 7, lapses: 2, weakShows: 6, weakRun: 0,
        unsureDays: ['2026-12-01', '2026-12-09'], today: { day: '2027-01-20', weakShows: 1 }, lastSeen: t - 3, lastGrade: 2, upd: t += 997 }; });
    const conf = {};
    all.slice(0, 300).forEach((it, i) => { const b = all[(i + 5) % all.length].id; conf[C.pairKey(it.id, b)] = { a: it.id < b ? it.id : b, b: it.id < b ? b : it.id, count: 3, lastDay: '2027-01-20', cleanDays: [], upd: i }; });
    const out = Y.packAll({ settings: {}, bests: {}, days: {}, items: { 'kanji-readings': items }, confusions: { 'kanji-readings': conf } }, '7f3c2a10-1234-4abc-9def-0123456789ab');
    const doc = out.decks['deck-kanji-readings'];
    console.log(`  Readings deck: ${all.length} items + 300 pairs → ${doc.length} characters, ${Buffer.byteLength(doc, 'utf8')} bytes`);
    assert.ok(doc.length < Y.MAX_CHARS * 0.3);
    const back = Y.unpack({ 'deck-kanji-readings': { v: 1, mt: 1, d: doc } });
    assert.equal(Object.keys(back.items['kanji-readings']).length, all.length);
});
