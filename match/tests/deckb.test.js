// Round 6: deck B (word with one kanji highlighted ↔ reading with that kanji's part marked) and the pair-key fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../match_core.js');
const S = require('../match_store.js');

const DATA = path.join(__dirname, '..', 'data');
const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const meta = load('meta.json');
const synIdx = C.synonymIndex(meta.synonyms);
const words = {}; C.LEVEL_ORDER.forEach(lv => { words[lv] = load(`words_${lv}.json`).items; });
const cards = {}; C.LEVEL_ORDER.forEach(lv => { cards[lv] = C.kanjiCards(words[lv]); });
const all = C.LEVEL_ORDER.flatMap(lv => cards[lv]);
const find = id => all.find(c => c.id === id);
const W = (k, r, split, kanji, alt = []) => ({ id: `w:${k}|${r}`, k, r, alt, split, kanji, lv: 'N5', freq: 1, strokes: k.length,
    shown: [r, '#' + k], keys: [...new Set([r, '#' + k, ...alt])] });
const mark = c => [c.k.slice(c.hk[0], c.hk[1]), c.r.slice(c.hr[0], c.hr[1])];

test('cards: one per kanji part; highlight and reading part for 1–3 kanji, okurigana, 々, read-together parts', () => {
    assert.deepEqual(C.kanjiCards([W('思う', 'おもう', '思:おも;う', ['思'])]), [], 'one-kanji words stay in deck C (decision 16)');
    assert.deepEqual(C.kanjiCards([W('人', 'ひと', '人:ひと', ['人'])]), []);
    const two = C.kanjiCards([W('自分', 'じぶん', '自:じ;分:ぶん', ['自', '分'])]);
    assert.deepEqual(two.map(c => c.id), ['h:自分|じぶん|自', 'h:自分|じぶん|分']);
    assert.deepEqual(two.map(mark), [['自', 'じ'], ['分', 'ぶん']]);
    const three = C.kanjiCards([W('図書館', 'としょかん', '図:と;書:しょ;館:かん', ['図', '書', '館'])]);
    assert.deepEqual(three.map(mark), [['図', 'と'], ['書', 'しょ'], ['館', 'かん']]);
    assert.deepEqual(C.kanjiCards([W('色々', 'いろいろ', '色:いろ;々:いろ', ['色'])]), [], '々 is not a second kanji');
    const rep = C.kanjiCards([W('時々刻々', 'じじこっこく', '時:じ;々:じ;刻:こっ;々:こく', ['時', '刻'])]);
    assert.deepEqual(rep.map(mark), [['時', 'じ'], ['刻', 'こっ']], '々 is never a target');
    const mid = C.kanjiCards([W('お茶会', 'おちゃかい', 'お;茶:ちゃ;会:かい', ['茶', '会'])]);
    assert.deepEqual(mid.map(mark), [['茶', 'ちゃ'], ['会', 'かい']], 'kana parts stay unmarked');
    const oku = C.kanjiCards([W('落ち着く', 'おちつく', '落:お;ち;着:つ;く', ['落', '着'])]);
    assert.deepEqual(oku.map(mark), [['落', 'お'], ['着', 'つ']], 'okurigana unmarked');
    const grp = C.kanjiCards([W('日本', 'にほん', '日本:にほん', ['日', '本'])]);
    assert.deepEqual(grp.map(mark), [['日本', 'にほん']], 'a part read together is one card');
    assert.deepEqual(C.kanjiCards([W('変', 'へん', '変:ちがう', ['変'])]), [], "a split that doesn't spell the reading gives no card");
    // card keeps the word's clash keys, level and gloss; own id; points back to the word
    assert.deepEqual([...two[0].keys].sort(), ['#自分', 'じぶん']); assert.equal(two[0].wid, 'w:自分|じぶん');
});

test('cards from the real data: every 2+ kanji word has a card, no one-kanji word does, ids unique, marks spell the word', () => {
    const ids = new Set();
    for (const lv of C.LEVEL_ORDER) {
        const wids = new Set(cards[lv].map(c => c.wid));
        words[lv].forEach(w => assert.equal(wids.has(w.id), w.kanji.length >= 2, w.id));
        console.log(`  ${lv}: ${words[lv].filter(w => w.kanji.length >= 2).length} words → ${cards[lv].length} cards`);
        for (const c of cards[lv]) {
            assert.ok(!ids.has(c.id), c.id); ids.add(c.id);
            const [k, r] = mark(c);
            assert.ok(k.length && r.length, c.id);
            assert.ok([...k].some(ch => c.kanji.includes(ch)), c.id);
            assert.equal(c.lv, lv);
        }
    }
    console.log(`  Deck B: ${all.length} cards from ${C.LEVEL_ORDER.reduce((n, lv) => n + words[lv].length, 0)} words`);
    assert.ok(find('h:時間|じかん|時') && find('h:時間|じかん|間'));
});

test('clash: a word at most once per board; identical readings (incl. alternatives) clash; others do not', () => {
    const [a, b] = C.kanjiCards([W('自分', 'じぶん', '自:じ;分:ぶん', ['自', '分'])]);
    assert.ok(C.clash(a, b, synIdx), 'same word, other kanji');
    const [h1] = C.kanjiCards([W('記者', 'きしゃ', '記:き;者:しゃ', ['記', '者'])]), [h2] = C.kanjiCards([W('汽車', 'きしゃ', '汽:き;車:しゃ', ['汽', '車'])]);
    assert.ok(C.clash(h1, h2, synIdx), 'homophones');
    const [n1] = C.kanjiCards([W('日本', 'にほん', '日本:にほん', ['日', '本'], ['にっぽん'])]);
    const [n2] = C.kanjiCards([W('日歩', 'にっぽん', '日:にっ;歩:ぽん', ['日', '歩'])]);
    assert.ok(C.clash(n1, n2, synIdx), 'alternative reading');
    assert.ok(!C.clash(a, h1, synIdx));
});

function boards(lv, n, opts = {}) {
    const pool = cards[lv], out = [];
    let states = {}, recent = [];
    for (let i = 0; i < n; i++) {
        const b = C.buildBoard(Object.assign({ pool, states, confusions: {}, size: 12, mode: 'play', recent, today: '2026-11-26', seed: 7 + i, synIdx, affinity: true }, opts));
        out.push(b);
        b.ids.forEach(id => { states[id] = states[id] || { box: 2, due: '2026-11-29', seen: 1, misses: 0, lapses: 0, lastSeen: i, lastGrade: 2, upd: i }; });
        recent = [b.ids].concat(recent).slice(0, 3);
    }
    return out;
}
const sharing = b => { const its = b.ids.map(find); return its.filter((x, i) => its.some((y, j) => j !== i && y.kanji.some(k => x.kanji.includes(k)))).length; };
for (const lv of ['N5', 'N4']) {
    test(`deck B boards fill 12 pairs at ${lv}, clash-free, and prefer words sharing kanji`, () => {
        const bs = boards(lv, 20);
        for (const b of bs) {
            assert.equal(b.ids.length, 12);
            const its = b.ids.map(find);
            for (let i = 0; i < its.length; i++) for (let j = i + 1; j < its.length; j++) assert.ok(!C.clash(its[i], its[j], synIdx), `${its[i].id} / ${its[j].id}`);
        }
        const withA = bs.reduce((n, b) => n + sharing(b), 0), without = boards(lv, 20, { affinity: false }).reduce((n, b) => n + sharing(b), 0);
        console.log(`  ${lv}: cards sharing a kanji with another card, 20 boards: ${withA} with the preference, ${without} without`);
        assert.ok(withA > without);
    });
}

test('pair keys: word ids with "|" give working mixed-up pairs (partnersOf, box cap)', () => {
    const x = 'w:第|だい', y = 'w:台|だい', D = '2026-11-26';
    const record = { size: 2, ids: [x, y], matches: [y, x], wrongPairs: [{ k: x, a: y }], abandoned: false };
    const r = C.applyBoard({ record, states: {}, confusions: {}, today: D, now: 1 });
    const key = C.pairKey(x, y);
    assert.deepEqual(Object.keys(r.confusions), [key]);
    assert.deepEqual([r.confusions[key].a, r.confusions[key].b], [x, y].sort());
    assert.deepEqual(C.partnersOf(r.confusions, x), [y]); assert.deepEqual(C.partnersOf(r.confusions, y), [x]);
    // a strong word that is in an active pair stays at the cap
    const strong = { [x]: { box: 3, due: D, seen: 5, misses: 0, lapses: 0, unsureDays: [], lastSeen: 0, lastGrade: 2, upd: 0 } };
    const r2 = C.applyBoard({ record: { size: 2, ids: [x, y], matches: [x, y], wrongPairs: [], abandoned: false }, states: strong, confusions: r.confusions, today: D, now: 2 });
    assert.equal(r2.changed[x].box, C.TUNING.CONFUSION_BOX_CAP);
    // deck B ids too
    const p = 'h:自分|じぶん|自', q = 'h:自身|じしん|自';
    assert.deepEqual(C.pairOf(C.pairKey(q, p)), [p, q].sort());
});

test('repair: old "a|b" keys (word and kanji) become JSON pairs with the right a/b; duplicates keep the newer', () => {
    const x = 'w:第|だい', y = 'w:台|だい';
    const old = {
        [x + '|' + y]: { a: 'w:第', b: 'だい|w:台|だい', count: 2, lastDay: '2026-11-25', cleanDays: [], upd: 10 },
        'k:休|k:体': { a: 'k:休', b: 'k:体', count: 1, lastDay: '2026-11-25', cleanDays: [] },
        [C.pairKey(x, y)]: { a: x, b: y, count: 5, lastDay: '2026-11-26', cleanDays: [], upd: 20 },
        'junk': { count: 1 },
    };
    const r = C.repairConfusions(old);
    assert.ok(r.changed);
    assert.deepEqual(Object.keys(r.conf).sort(), [C.pairKey('k:休', 'k:体'), C.pairKey(x, y)].sort());
    assert.equal(r.conf[C.pairKey(x, y)].count, 5, 'newer entry kept');
    assert.deepEqual(C.repairConfusions(r.conf), { conf: r.conf, changed: false }, 'repair is stable');
});

test('repair on load: saved old keys are fixed in local storage, other data untouched', async () => {
    const s = S.memory(), x = 'w:第|だい', y = 'w:台|だい';
    await s.saveBoard({ deck: 'word-reading', items: { [x]: { box: 2 } }, confusions: { [x + '|' + y]: { a: 'w:第', b: 'だい|w:台|だい', count: 1, lastDay: '2026-11-25', cleanDays: [] } }, bests: {} });
    const d = await s.load();
    assert.deepEqual(Object.keys(d.confusions['word-reading']), [C.pairKey(x, y)]);
    assert.deepEqual(C.partnersOf(d.confusions['word-reading'], x), [y]);
    assert.deepEqual(JSON.parse(s._storage.getItem(S.PREFIX + 'confusions.word-reading')), d.confusions['word-reading']);
    assert.equal(d.items['word-reading'][x].box, 2);
    assert.deepEqual(d.items['word-kanji'], {}, 'deck B starts empty');
});
