// Round 3: Words cards (word ↔ reading), v1 progress kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../match_core.js');
const S = require('../match_store.js');

const DATA = path.join(__dirname, '..', 'data');
const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).items;
const LV = C.LEVEL_ORDER;
const kanjiLevel = {};
LV.forEach(lv => load(`kanji_${lv}.json`).forEach(it => { kanjiLevel[it.k] = lv; }));
const words = {};
LV.forEach(lv => { words[lv] = load(`words_${lv}.json`); });
const isKanji = c => c >= '一' && c <= '鿿';
const W = (t, r, alt = []) => ({ id: `w:${t}|${r}`, k: t, r, alt, shown: [r, '#' + t], keys: [...new Set([r, '#' + t, ...alt])] });

test('word level = hardest kanji; no kana-only words; every kanji known; ids unique', () => {
    const ids = new Set();
    for (const lv of LV) for (const w of words[lv]) {
        const ks = [...w.k].filter(c => isKanji(c));
        assert.ok(ks.length > 0, w.id);
        ks.forEach(c => assert.ok(kanjiLevel[c], `${w.id}: ${c}`));
        const hardest = ks.map(c => kanjiLevel[c]).sort((a, b) => LV.indexOf(b) - LV.indexOf(a))[0];
        assert.equal(w.lv, hardest, w.id);
        assert.equal(lv, w.lv);
        assert.ok(!ids.has(w.id), w.id); ids.add(w.id);
    }
    assert.ok(words.N5.length > 100);
});

test('homophones, alternative readings and the same spelling clash', () => {
    assert.ok(C.clash(W('橋', 'はし'), W('箸', 'はし')));                          // same reading
    assert.ok(C.clash(W('一日', 'いちにち', ['ついたち']), W('朔', 'ついたち')));     // listed alternative
    assert.ok(C.clash(W('朔', 'ついたち'), W('一日', 'いちにち', ['ついたち'])));     // either way round
    assert.ok(C.clash(W('何', 'なに', ['なん']), W('何', 'なん', ['なに'])));          // same word, two readings
    assert.ok(C.clash(W('上手', 'じょうず'), W('上手', 'うわて')));                    // same spelling
    assert.ok(!C.clash(W('安心', 'あんしん'), W('安全', 'あんぜん')));
    const real = words.N5.filter(w => w.k === '何');
    assert.equal(real.length, 2);
    assert.ok(C.clash(real[0], real[1]));
});

test('Words boards fill 12 pairs at N5 and N4, clash-free', () => {
    for (const lv of ['N5', 'N4']) {
        for (let seed = 1; seed <= 200; seed++) {
            const b = C.buildBoard({ pool: words[lv], states: {}, size: 12, mode: 'play', today: '2026-11-25', seed });
            assert.equal(b.ids.length, 12, `${lv} seed ${seed}`);
            const its = b.ids.map(id => words[lv].find(w => w.id === id));
            for (let i = 0; i < its.length; i++) for (let j = i + 1; j < its.length; j++)
                assert.ok(!C.clash(its[i], its[j]), `${its[i].id} / ${its[j].id}`);
        }
    }
});

// keep going / level switches: see levels_keys.test.js (round 4)

test('v1 Meaning progress is unchanged after the update', async () => {
    const mem = S.memoryStorage();
    const v1 = { 'k:山': { box: 4, due: '2026-12-01' }, 'k:川': { box: 1, due: '2026-11-20' } };
    mem.setItem(S.PREFIX + 'items.kanji-meaning', JSON.stringify(v1));
    mem.setItem(S.PREFIX + 'confusions.kanji-meaning', JSON.stringify({ 'k:休|k:体': { a: 'k:休', b: 'k:体', count: 1, lastDay: 'x', cleanDays: [] } }));
    mem.setItem(S.PREFIX + 'settings', JSON.stringify({ level: 'N5', includeLower: true, size: 8 }));
    const s = S.create(mem);
    const d = await s.load();
    assert.deepEqual(d.items['kanji-meaning'], v1);
    assert.deepEqual(d.items['word-reading'], {});
    assert.equal(Object.keys(d.confusions['kanji-meaning']).length, 1);
    // a v1 backup (Meaning deck only) imports without losing anything
    const exp = await s.exportAll();
    delete exp.decks['word-reading'];
    const s2 = S.memory();
    await s2.importAll(exp);
    assert.deepEqual((await s2.load()).items['kanji-meaning'], v1);
});
