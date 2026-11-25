// Simulation regression test: plays many boards with a simple model of a learner and checks that
// the tracking rules still behave as designed (plan §2 and §6.5). If you change TUNING in
// match_core.js, run this to see whether the behaviour is still sensible:
//   node --test match/tests/sim.test.js         (add SIM_VERBOSE=1 to print the numbers)
process.env.TZ = 'Asia/Tokyo';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../match_core.js');

const DATA = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
const N5 = JSON.parse(fs.readFileSync(path.join(DATA, 'kanji_N5.json'), 'utf8')).items;
const TAI = JSON.parse(fs.readFileSync(path.join(DATA, 'kanji_N4.json'), 'utf8')).items.find(x => x.k === '体');
const POOL = N5.concat(TAI);
const synIdx = C.synonymIndex(meta.synonyms);

const ALWAYS = 'k:山', NEVER = 'k:午', PARTIAL = 'k:北', KYU = 'k:休', TAI_ID = 'k:体';

function playBoard(ids, learner, rand) {
    const known = [], unknown = [];
    ids.forEach(id => ((learner.knows(id, rand) ? known : unknown).push(id)));
    const matches = [], wrongPairs = [];
    const remaining = new Set(ids);
    if (ids.includes(TAI_ID) && ids.includes(KYU) && rand() < learner.confuse) wrongPairs.push({ k: TAI_ID, a: KYU });
    C.shuffle(known, rand).forEach(id => { matches.push(id); remaining.delete(id); });
    C.shuffle(unknown, rand).forEach(id => {
        const cands = C.shuffle([...remaining].filter(x => x !== id), rand);
        const wrongTries = Math.floor(rand() * (cands.length + 1));
        cands.slice(0, wrongTries).forEach(a => wrongPairs.push({ k: id, a }));
        matches.push(id); remaining.delete(id);
        learner.expose(id, rand);
    });
    return { size: ids.length, ids, matches, wrongPairs, abandoned: false };
}

function run(seed, { size = 8, days = 10, perDay = 10, knownCount = 60 } = {}) {
    const rand = C.rng(seed * 7919 + 1);
    const others = POOL.map(x => x.id).filter(id => ![ALWAYS, NEVER, PARTIAL, KYU, TAI_ID].includes(id));
    const startKnown = new Set([ALWAYS, KYU, TAI_ID, ...C.shuffle(others, rand).slice(0, knownCount - 3)]);
    const learner = {
        k: startKnown, confuse: 0.6,
        knows(id, r) { return id === PARTIAL ? r() < 0.7 : this.k.has(id); },
        expose(id, r) { if (id !== NEVER && id !== PARTIAL && r() < 0.25) this.k.add(id); },
    };
    let states = {}, confusions = {};
    const recent = [], out = { conf: { kk: 0, ku: 0, uk: 0, uu: 0 }, neverBoards: 0, strongDay: null, firstDay: null, confusedStrong: false, boards: 0 };
    const t0 = Date.parse('2026-11-19T20:00:00+09:00');
    for (let d = 0; d < days; d++) {
        for (let b = 0; b < perDay; b++) {
            const now = t0 + d * 86400000 + b * 120000, today = C.studyDay(now);
            const board = C.buildBoard({ pool: POOL, states, confusions, size, mode: 'play', recent, today, seed: seed * 1000 + out.boards, synIdx });
            const truth = Object.fromEntries(board.ids.map(id => [id, learner.knows(id, () => 0.5) && id !== PARTIAL]));
            const rec = playBoard(board.kanjiOrder, learner, rand);
            const r = C.applyBoard({ record: rec, states, confusions, today, now });
            for (const id of board.ids) {
                if ([PARTIAL, KYU, TAI_ID].includes(id)) continue;
                const g = r.grades[id].grade, k = truth[id];
                if (k && g === 2) out.conf.kk++; else if (k) out.conf.ku++; else if (g === 2) out.conf.uk++; else out.conf.uu++;
            }
            states = Object.assign({}, states, r.changed);
            confusions = r.confusions;
            if (board.ids.includes(NEVER)) out.neverBoards++;
            if (out.firstDay === null && states[ALWAYS]) out.firstDay = d + 1;
            if (out.strongDay === null && C.band(states[ALWAYS]) === 'strong') out.strongDay = d + 1;
            const active = C.partnersOf(confusions, TAI_ID).length > 0;
            if (active && (C.band(states[TAI_ID]) === 'strong' || C.band(states[KYU]) === 'strong')) out.confusedStrong = true;
            recent.unshift(board.ids); recent.length = Math.min(recent.length, 3);
            out.boards++;
        }
    }
    out.final = { never: C.band(states[NEVER]), always: C.band(states[ALWAYS]) };
    out.seen = POOL.filter(x => states[x.id]).length;
    return out;
}

for (const size of [6, 8, 12]) {
    test(`simulation, ${size}-pair boards`, () => {
        const R = Array.from({ length: 60 }, (_, i) => run(i + 1, { size }));
        const sum = R.reduce((a, r) => { for (const k in r.conf) a[k] += r.conf[k]; return a; }, { kk: 0, ku: 0, uk: 0, uu: 0 });
        const knownUnsure = sum.ku / (sum.kk + sum.ku), unknownKnown = sum.uk / (sum.uk + sum.uu);
        // days from first sighting: box 2 on day 1, box 3 on day 2, box 4 (Strong) on day 5 at the earliest
        const strongBy6 = R.filter(r => r.strongDay !== null && r.strongDay - r.firstDay + 1 <= 6).length / R.length;
        const neverShare = R.reduce((a, r) => a + r.neverBoards / r.boards, 0) / R.length;
        if (process.env.SIM_VERBOSE) console.log({ size, knownUnsure, unknownKnown, strongBy6, neverShare,
            seenAll: R.filter(r => r.seen === POOL.length).length / R.length });
        assert.ok(strongBy6 >= 0.85, `always-known kanji Strong within 6 days of first sighting in ${(strongBy6 * 100).toFixed(0)}% of runs`);
        assert.ok(R.every(r => r.final.never === 'weak'), 'never-known kanji is Weak at day 10');
        assert.ok(neverShare <= 0.35, `never-known kanji on ${(neverShare * 100).toFixed(0)}% of boards`);
        assert.ok(R.every(r => !r.confusedStrong), 'a kanji in an active mixed-up pair is never Strong');
        assert.ok(knownUnsure >= 0.10 && knownUnsure <= 0.30, `known kanji graded Unsure ${(knownUnsure * 100).toFixed(0)}%`);
        assert.ok(unknownKnown <= 0.05, `unknown kanji graded Known ${(unknownKnown * 100).toFixed(0)}%`);
    });
}
