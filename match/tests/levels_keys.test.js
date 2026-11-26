// Round 4: level switches (decision 5), board sizes (decision 8), keyboard play (decision 9).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../match_core.js');
const S = require('../match_store.js');

const DATA = path.join(__dirname, '..', 'data');
const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).items;
const kanji = {};
C.LEVEL_ORDER.forEach(lv => { kanji[lv] = load(`kanji_${lv}.json`); });
const TODAY = '2026-11-25';
const st = (box, due) => ({ box, due, seen: 1, misses: 0, lapses: 0, weakShows: 0, weakRun: 0, unsureDays: [],
                            today: { day: '2026-11-20', weakShows: 0 }, lastSeen: 1, lastGrade: 2, upd: 1 });
const seenAll = (states, lv, due = '2026-12-30') => kanji[lv].forEach(it => { states[it.id] = st(2, due); });
const lvOf = id => C.LEVEL_ORDER.find(lv => kanji[lv].some(it => it.id === id));

function plan(level, includeEasier, keepGoing, states, played = []) {
    const r = C.levelsInPlay({ level, includeEasier, keepGoing, levels: kanji, states });
    assert.equal(r.need, null);
    return {
        r, label: C.playingLabel(r),
        pool: C.poolFor({ inPlay: r.levels, played, levels: kanji, states }),
        review: C.poolFor({ inPlay: r.levels, played, levels: kanji, states, review: true }),
    };
}

test('levels: the two switches, every combination (N4 chosen, N4 not fully seen)', () => {
    const states = {};
    seenAll(states, 'N5');
    kanji.N4.slice(0, 5).forEach(it => { states[it.id] = st(2, '2026-11-24'); });
    kanji.N3.slice(0, 3).forEach(it => { states[it.id] = st(2, '2026-11-24'); });   // N3 played earlier
    const played = ['N5', 'N4', 'N3'];
    for (const keep of [false, true]) {
        const off = plan('N4', false, keep, states, played);
        assert.deepEqual(off.r.levels, ['N4']); assert.equal(off.label, 'N4');
        assert.equal(off.pool.length, kanji.N4.length);                       // no seen N5/N3 items pulled in
        const on = plan('N4', true, keep, states, played);
        assert.deepEqual(on.r.levels, ['N5', 'N4']); assert.equal(on.label, 'N5–N4');
        assert.equal(on.pool.length, kanji.N5.length + kanji.N4.length);
    }
});

test('levels: keep going past a fully seen level, with and without easier levels', () => {
    const states = {};
    seenAll(states, 'N5'); seenAll(states, 'N4');
    let p = plan('N4', false, true, states);
    assert.deepEqual(p.r.levels, ['N4', 'N3']); assert.equal(p.label, 'N4 → N3');
    const b = C.buildBoard({ pool: p.pool, states, confusions: {}, size: 12, mode: 'play', today: TODAY, seed: 5 });
    b.ids.filter(id => !states[id]).forEach(id => assert.equal(lvOf(id), 'N3'));
    assert.ok(b.ids.some(id => !states[id]));
    p = plan('N4', true, true, states);
    assert.deepEqual(p.r.levels, ['N5', 'N4', 'N3']); assert.equal(p.label, 'N5–N4 → N3');
    p = plan('N4', false, false, states);
    assert.deepEqual(p.r.levels, ['N4']);
    // two levels fully seen: keep going goes on to N2
    seenAll(states, 'N3');
    p = plan('N4', false, true, states);
    assert.deepEqual(p.r.levels, ['N4', 'N3', 'N2']); assert.equal(p.label, 'N4 → N2');
    // N1 fully seen: nothing after it, Extras never added
    const all = {}; seenAll(all, 'N1');
    assert.deepEqual(plan('N1', false, true, all).r.levels, ['N1']);
    // Extras with easier levels: N5–N1 + Extras
    assert.deepEqual(C.levelsInPlay({ level: 'X', includeEasier: true, keepGoing: true, levels: kanji, states: {} }).levels,
                     ['N5', 'N4', 'N3', 'N2', 'N1', 'X']);
});

test('levels: asks for a level that is not loaded yet', () => {
    const states = {}; seenAll(states, 'N5');
    const r = C.levelsInPlay({ level: 'N5', includeEasier: false, keepGoing: true, levels: { N5: kanji.N5 }, states });
    assert.equal(r.need, 'N4');
    assert.equal(C.levelsInPlay({ level: 'N4', includeEasier: true, keepGoing: false, levels: { N4: kanji.N4 }, states }).need, 'N5');
});

test('Review covers every played level; Play does not pull in other levels', () => {
    const states = {};
    kanji.N5.slice(0, 4).forEach(it => { states[it.id] = st(2, '2026-11-24'); });   // due, N5
    kanji.N3.slice(0, 4).forEach(it => { states[it.id] = st(2, '2026-11-24'); });   // due, N3
    const p = plan('N4', false, true, states, ['N5', 'N3']);
    assert.ok(p.pool.every(it => lvOf(it.id) === 'N4'));
    assert.equal(p.review.length, kanji.N4.length + 8);                       // only seen items of played levels
    const rv = C.buildBoard({ pool: p.review, states, confusions: {}, size: 12, mode: 'review', today: TODAY, seed: 2 });
    const lvs = new Set(rv.ids.map(lvOf));
    assert.ok(lvs.has('N5') && lvs.has('N3'));
    rv.ids.filter(id => lvOf(id) !== 'N4').forEach(id => assert.ok(states[id]));   // short boards fill from N4 (v1 rule)
});

test('board sizes: Quick 6 / Full 12; a saved 8 becomes 12', async () => {
    assert.deepEqual(C.SIZES, [6, 12]);
    assert.equal(C.normSize(6), 6); assert.equal(C.normSize('6'), 6);
    [8, 12, '8', undefined, null, 16].forEach(n => assert.equal(C.normSize(n), 12));
    // v1/R3 saved settings load without errors
    const mem = S.memoryStorage();
    mem.setItem(S.PREFIX + 'settings', JSON.stringify({ level: 'N5', includeLower: true, keepGoing: true, size: 8 }));
    const d = await S.create(mem).load();
    assert.equal(C.normSize(d.settings.size), 12);
    assert.equal(d.settings.includeLower, true);   // the page maps it to includeEasier
    for (const size of C.SIZES) {
        const b = C.buildBoard({ pool: kanji.N5, states: {}, confusions: {}, size, mode: 'play', today: TODAY, seed: 1 });
        assert.equal(b.ids.length, size);
    }
});

test('key map: 12 = 3 × 4 and 6 = 2 × 3 per side; each key → one card', () => {
    const m12 = C.keyMap(12), m6 = C.keyMap(6);
    assert.equal(m12.k.map(C.keyLabel).join(''), 'qwerasdfzxcv'.toUpperCase());
    assert.equal(m12.a.map(C.keyLabel).join(''), 'UIOPJKL;M,./');
    assert.equal(m6.k.map(C.keyLabel).join(''), 'QWEASD');
    assert.equal(m6.a.map(C.keyLabel).join(''), 'UIOJKL');
    for (const n of [6, 12]) {
        const m = C.keyMap(n), all = [...m.k, ...m.a];
        assert.equal(new Set(all).size, 2 * n);
        m.k.forEach((code, i) => assert.deepEqual(C.keyTarget({ code }, n), { side: 'k', index: i }));
        m.a.forEach((code, i) => assert.deepEqual(C.keyTarget({ code }, n), { side: 'a', index: i }));
    }
    assert.equal(C.keyTarget({ code: 'KeyR' }, 6), null);        // not on a Quick board
    assert.equal(C.keyTarget({ code: 'KeyT' }, 12), null);
    // smaller boards (tiny pool / short review) still map row by row
    assert.deepEqual(C.keyMap(4).k.map(C.keyLabel), ['Q', 'W', 'E', 'A']);
});

test('keys are ignored with Ctrl/Alt/Meta held and when a field, dialog or the learn panel has focus', () => {
    ['ctrlKey', 'altKey', 'metaKey'].forEach(mod => assert.equal(C.keyTarget({ code: 'KeyQ', [mod]: true }, 12), null));
    assert.deepEqual(C.keyTarget({ code: 'KeyQ', shiftKey: true }, 12), { side: 'k', index: 0 });
    const node = (tagName, inside = null, extra = {}) => Object.assign({ tagName, closest: sel => (inside && sel.split(', ').some(s => s === inside) ? {} : null) }, extra);
    assert.equal(C.keyAllowed(node('BUTTON')), true);
    assert.equal(C.keyAllowed(node('BODY')), true);
    assert.equal(C.keyAllowed(node('INPUT')), false);
    assert.equal(C.keyAllowed(node('TEXTAREA')), false);
    assert.equal(C.keyAllowed(node('SELECT')), false);
    assert.equal(C.keyAllowed(node('DIV', null, { isContentEditable: true })), false);
    assert.equal(C.keyAllowed(node('BUTTON', '[role="alertdialog"]')), false);
    assert.equal(C.keyAllowed(node('BUTTON', '[role="dialog"]')), false);
    assert.equal(C.keyAllowed(node('A', '.learn')), false);
});
