// node --test match/tests      (Node 18+; no dependencies)
process.env.TZ = 'Asia/Tokyo';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const C = require('../match_core.js');

const DATA = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
const level = lv => JSON.parse(fs.readFileSync(path.join(DATA, `kanji_${lv}.json`), 'utf8')).items;
const N5 = level('N5'), N4 = level('N4');
const byK = new Map([...N5, ...N4].map(it => [it.k, it]));
const syn = C.synonymIndex(meta.synonyms);
const K = k => byK.get(k);
const id = k => 'k:' + k;
const DAY = '2026-11-19', NOW = Date.parse('2026-11-19T20:00:00+09:00');

test('norm matches the build script', () => {
    assert.equal(C.norm('To Rest (a while)'), 'rest');
    assert.equal(C.norm('  the  big   house '), 'big house');
});

test('clash rule', () => {
    assert.ok(C.clash(K('先'), K('前'), syn), '先/前 share "before"');
    assert.ok(C.clash(K('家'), K('屋'), syn), '家/屋: house');
    assert.ok(C.clash(K('言'), K('語'), syn), '言/語: word');
    assert.ok(C.clash(K('話'), K('言'), syn), '話/言 via synonyms (talk/say)');
    assert.ok(!C.clash(K('休'), K('体'), syn), 'look-alikes with different meanings may share a board');
    assert.ok(!C.clash(K('山'), K('川'), syn));
    assert.ok(C.clash(K('山'), K('山'), syn), 'same item');
});

test('study day starts at 04:00 local time', () => {
    assert.equal(C.studyDay(Date.parse('2026-11-20T03:59:00+09:00')), '2026-11-19');
    assert.equal(C.studyDay(Date.parse('2026-11-20T04:00:00+09:00')), '2026-11-20');
    assert.equal(C.addDays('2026-12-30', 3), '2027-01-02');
    assert.equal(C.dayDiff('2026-11-19', '2026-11-26'), 7);
});

function board(ids, matches, wrongPairs = [], abandoned = false) {
    return { size: ids.length, ids, matches, wrongPairs, abandoned };
}
const EIGHT = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

test('grading: late thresholds by board size', () => {
    for (const [N, late] of [[6, 2], [8, 3], [12, 4]]) {
        const ids = Array.from({ length: N }, (_, i) => 'i' + i);
        const g = C.gradeBoard(board(ids, ids));
        const unsure = ids.filter(x => g[x].grade === C.GRADE.UNSURE).length;
        assert.equal(unsure, late, `N=${N}`);
        assert.equal(g[ids[N - 1]].grade, C.GRADE.UNSURE, 'last pair is late');
        assert.equal(g[ids[0]].grade, C.GRADE.KNOWN);
    }
});

test('grading: kanji side Missed, answer side Unsure, miss beats early', () => {
    const g = C.gradeBoard(board(EIGHT, EIGHT, [{ k: 'a', a: 'b' }]));
    assert.equal(g.a.grade, C.GRADE.MISSED);       // matched first, but was the kanji side of a miss
    assert.equal(g.b.grade, C.GRADE.UNSURE);       // answer side only
    assert.equal(g.c.grade, C.GRADE.KNOWN);
    assert.equal(g.a.kSide, 1);
    assert.equal(C.firstTry(g), 7);
});

test('grading: abandoned board only applies misses', () => {
    const g = C.gradeBoard(board(EIGHT, ['c', 'd'], [{ k: 'e', a: 'f' }], true));
    assert.equal(g.e.grade, C.GRADE.MISSED);
    assert.equal(g.c.grade, null);
    assert.equal(g.f.grade, null);
});

test('scheduler: first sighting', () => {
    assert.deepEqual([C.applyGrade(undefined, 2, DAY, NOW).box, C.applyGrade(undefined, 2, DAY, NOW).due], [2, '2026-11-20']);
    assert.equal(C.applyGrade(undefined, 1, DAY, NOW).box, 1);
    assert.equal(C.applyGrade(undefined, 0, DAY, NOW).box, 1);
});

test('scheduler: known kanji climbs only when due (worked example 学)', () => {
    let s = C.applyGrade(undefined, 2, '2026-11-19', NOW);             // D1 new, Known
    s = C.applyGrade(s, 1, '2026-11-19', NOW);                          // D1 late on a fill board
    assert.equal(s.box, 2);
    s = C.applyGrade(s, 2, '2026-11-19', NOW);                          // not due: no change
    assert.equal(s.box, 2);
    s = C.applyGrade(s, 2, '2026-11-20', NOW);                          // D2 due
    assert.deepEqual([s.box, s.due], [3, '2026-11-23']);
    s = C.applyGrade(s, 2, '2026-11-23', NOW);                          // D5
    assert.deepEqual([s.box, s.due, C.band(s)], [4, '2026-11-30', 'strong']);
    s = C.applyGrade(s, 2, '2026-11-30', NOW);
    assert.deepEqual([s.box, s.due], [5, '2026-12-21']);
    s = C.applyGrade(s, 2, '2026-12-21', NOW);
    assert.equal(s.box, 5, 'box 5 stays 5');
});

test('scheduler: unsure on two different days drops a box; same day twice does not', () => {
    let s = { box: 3, due: '2026-11-25', seen: 3, misses: 0, lapses: 0, weakShows: 0, weakRun: 0, unsureDays: [], today: null, lastSeen: 0, lastGrade: 2 };
    s = C.applyGrade(s, 1, '2026-11-19', NOW);
    s = C.applyGrade(s, 1, '2026-11-19', NOW);
    assert.equal(s.box, 3);
    s = C.applyGrade(s, 1, '2026-11-20', NOW);
    assert.deepEqual([s.box, s.due], [2, '2026-11-20']);
});

test('scheduler: a miss sends a kanji back to box 1 and counts a lapse', () => {
    let s = { box: 4, due: '2026-11-25', seen: 9, misses: 0, lapses: 0, weakShows: 0, weakRun: 0, unsureDays: [], today: null, lastSeen: 0, lastGrade: 2 };
    s = C.applyGrade(s, 0, DAY, NOW, { kSide: 2 });
    assert.deepEqual([s.box, s.due, s.lapses, s.misses], [1, DAY, 1, 2]);
});

test('scheduler: confusion cap keeps a kanji at box 3', () => {
    let s = { box: 3, due: DAY, seen: 5, misses: 1, lapses: 0, weakShows: 0, weakRun: 0, unsureDays: [], today: null, lastSeen: 0, lastGrade: 2 };
    s = C.applyGrade(s, 2, DAY, NOW, { cap: 3 });
    assert.deepEqual([s.box, s.due], [3, '2026-11-22']);
    let t = Object.assign({}, s, { box: 5, due: '2026-12-30' });
    t = C.applyGrade(t, 2, DAY, NOW, { cap: 3 });
    assert.equal(t.box, 3, 'a new confusion pulls a strong kanji down to 3');
});

test('trouble kanji', () => {
    assert.ok(C.isTrouble({ box: 2, lapses: 3, weakRun: 0 }));
    assert.ok(C.isTrouble({ box: 1, lapses: 0, weakRun: 6 }));
    assert.ok(!C.isTrouble({ box: 1, lapses: 1, weakRun: 5 }));
    let s;
    for (let i = 0; i < 7; i++) s = C.applyGrade(s, 1, DAY, NOW);
    assert.ok(C.isTrouble(s), 'never known after 7 showings');
});

test('confusions: active until two clean days together', () => {
    const ids = ['k:休', 'k:体', 'x', 'y', 'z', 'w'];
    let conf = C.updateConfusions({}, board(ids, ids, [{ k: 'k:体', a: 'k:休' }]), C.gradeBoard(board(ids, ids, [{ k: 'k:体', a: 'k:休' }])), '2026-11-19');
    const key = C.pairKey('k:休', 'k:体');
    assert.ok(C.isActive(conf[key]));
    assert.deepEqual(C.partnersOf(conf, 'k:休'), ['k:体']);
    const clean = board(ids, ids);
    conf = C.updateConfusions(conf, clean, C.gradeBoard(clean), '2026-11-20');
    conf = C.updateConfusions(conf, clean, C.gradeBoard(clean), '2026-11-20');
    assert.ok(C.isActive(conf[key]), 'same day twice counts once');
    conf = C.updateConfusions(conf, clean, C.gradeBoard(clean), '2026-11-22');
    assert.ok(!C.isActive(conf[key]));
    const again = board(ids, ids, [{ k: 'k:休', a: 'k:体' }]);
    conf = C.updateConfusions(conf, again, C.gradeBoard(again), '2026-11-23');
    assert.ok(C.isActive(conf[key]) && conf[key].count === 2 && conf[key].cleanDays.length === 0);
});

test('applyBoard: worked example 休/体', () => {
    const ids = ['k:休', 'k:体', 'k:山', 'k:川', 'k:日', 'k:月'];
    const rec = board(ids, ['k:山', 'k:川', 'k:日', 'k:休', 'k:月', 'k:体'], [{ k: 'k:体', a: 'k:休' }]);
    const states = { 'k:休': { box: 3, due: DAY, seen: 4, misses: 0, lapses: 0, weakShows: 0, weakRun: 0, unsureDays: [], today: null, lastSeen: 0, lastGrade: 2 } };
    const r = C.applyBoard({ record: rec, states, confusions: {}, today: DAY, now: NOW });
    assert.equal(r.changed['k:体'].box, 1);
    assert.equal(r.changed['k:休'].box, 3, '休 answer side: Unsure once keeps its box');
    assert.ok(C.isActive(r.confusions[C.pairKey('k:休', 'k:体')]));
});

// ---------------------------------------------------------------- board building
const POOL = N5;
function build(extra) {
    return C.buildBoard(Object.assign({ pool: POOL, states: {}, confusions: {}, size: 8, mode: 'play',
                                         recent: [], today: DAY, seed: 7, synonyms: meta.synonyms }, extra));
}
const st = (box, due, extra) => Object.assign({ box, due, seen: 3, misses: 1, lapses: 0, weakShows: 0, weakRun: 0,
    unsureDays: [], today: null, lastSeen: 1000, lastGrade: box === 1 ? 0 : 2 }, extra);

test('board: new player gets the most common kanji first, no clashes, no duplicates', () => {
    for (const size of [6, 8, 12]) {
        const b = build({ size });
        assert.equal(b.ids.length, size);
        assert.equal(new Set(b.ids).size, size);
        assert.deepEqual([...b.kanjiOrder].sort(), [...b.ids].sort());
        const items = b.ids.map(i => POOL.find(p => p.id === i));
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++)
            assert.ok(!C.clash(items[i], items[j], syn), `${items[i].k}/${items[j].k} clash`);
    }
    assert.ok(build({}).ids.includes('k:日') || build({}).ids.includes('k:人'), 'frequency order');
});

test('board: same seed gives the same board', () => {
    assert.deepEqual(build({ seed: 42 }), build({ seed: 42 }));
});

test('board: weak quota, gap of 2 boards and daily cap', () => {
    const states = {};
    const weakIds = ['k:山', 'k:川', 'k:雨', 'k:犬'];
    weakIds.forEach(i => { states[i] = st(1, DAY); });
    POOL.slice(0, 40).forEach(it => { if (!states[it.id]) states[it.id] = st(2, '2026-11-25'); });
    let b = build({ states });
    assert.equal(b.ids.filter(i => weakIds.includes(i)).length, 2, 'ceil(8/4) = 2 weak');
    b = build({ states, recent: [['k:山'], ['k:川']] });
    assert.ok(!b.ids.includes('k:山') && !b.ids.includes('k:川') || b.parts.weak > 2, 'weak kanji skip 2 boards');
    states['k:雨'] = st(1, DAY, { today: { day: DAY, weakShows: 4 } });
    states['k:犬'] = st(1, DAY, { today: { day: DAY, weakShows: 4 } });
    b = build({ states, recent: [['k:山'], ['k:川']] });
    assert.ok(!b.ids.includes('k:雨') && !b.ids.includes('k:犬'), 'daily cap');
});

test('board: new-kanji quota follows the weak backlog', () => {
    const count = states => build({ states }).parts.new;
    const base = {};
    POOL.slice(0, 30).forEach(it => { base[it.id] = st(2, '2026-11-25'); });
    assert.equal(count(base), 4, 'few weak → ceil(8/2) new');
    const mid = Object.assign({}, base); POOL.slice(30, 40).forEach(it => { mid[it.id] = st(1, DAY); });
    assert.equal(count(mid), 2, '8–15 weak → ceil(8/4) new');
    const many = Object.assign({}, base); POOL.slice(30, 50).forEach(it => { many[it.id] = st(1, DAY); });
    assert.equal(count(many), 1, '≥ 16 weak → 1 new');
});

test('board: due kanji fill before not-due kanji', () => {
    const states = {};
    POOL.forEach((it, i) => { states[it.id] = st(2, i < 10 ? DAY : '2026-11-30'); });
    const b = build({ states });
    const dueOnBoard = b.ids.filter(i => states[i].due === DAY).length;
    assert.ok(dueOnBoard >= 8 - 0, `due first (${dueOnBoard})`);
});

test('board: active confusion partner always comes along', () => {
    const states = {}; POOL.forEach(it => { states[it.id] = st(2, '2026-11-30'); });
    states['k:休'] = st(1, DAY);
    const confusions = { [C.pairKey('k:休', 'k:体')]: { a: 'k:休', b: 'k:体', count: 1, lastDay: DAY, cleanDays: [] } };
    const pool = POOL.concat(N4.filter(x => x.k === '体'));
    const b = C.buildBoard({ pool, states, confusions, size: 8, mode: 'play', recent: [], today: DAY, seed: 1, synonyms: meta.synonyms });
    assert.ok(b.ids.includes('k:休') && b.ids.includes('k:体'));
});

test('board: review mode', () => {
    const states = {}; POOL.forEach(it => { states[it.id] = st(3, '2026-11-30'); });
    let b = build({ states, mode: 'review' });
    assert.ok(b.empty, 'nothing due');
    states['k:山'] = st(1, DAY); states['k:川'] = st(2, DAY);
    b = build({ states, mode: 'review' });
    assert.equal(b.ids.length, 8);
    assert.ok(b.ids.includes('k:山') && b.ids.includes('k:川'));
    assert.equal(b.parts.new, 0);
});

test('board: tiny pool makes a smaller board', () => {
    const b = C.buildBoard({ pool: POOL.slice(0, 5), states: {}, size: 8, mode: 'play', recent: [], today: DAY, seed: 1, synonyms: meta.synonyms });
    assert.ok(b.ids.length <= 5 && b.small);
});

test('bests and pool levels', () => {
    assert.ok(C.isBetter({ misses: 0, activeMs: 90000 }, { misses: 1, activeMs: 30000 }));
    assert.ok(C.isBetter({ misses: 1, activeMs: 20000 }, { misses: 1, activeMs: 30000 }));
    assert.ok(!C.isBetter({ misses: 2, activeMs: 1000 }, { misses: 1, activeMs: 30000 }));
    assert.equal(C.bestKey('kanji-meaning', 'N4', true, 8), 'kanji-meaning|N4|lower1|8');
    assert.deepEqual(C.poolLevels('N3', true), ['N5', 'N4', 'N3']);
    assert.deepEqual(C.poolLevels('N1', true), ['N5', 'N4', 'N3', 'N2', 'N1']);
    assert.deepEqual(C.poolLevels('X', false), ['X']);
});
