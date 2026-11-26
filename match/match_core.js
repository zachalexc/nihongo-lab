// Kanji Match: pure game logic (no DOM, no storage). Runs in the browser (window.MatchCore)
// and in Node for the tests (require('./match_core.js')).
//
// Everything that decides how kanji are graded, scheduled and picked for a board is here.
// The numbers that are likely to need tuning after real use are all in TUNING below.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MatchCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ------------------------------------------------------------------ tuning
    const TUNING = {
        // Grading: a pair cleared when at most ceil(N * LATE_FRACTION) pairs were left
        // (including itself) counts as "late" (last 2 of 6, last 3 of 8, last 4 of 12).
        LATE_FRACTION: 1 / 3,

        // Boxes: 1 = weak (due again at once); 2-3 = learning; 4-5 = strong.
        // Days until a kanji is due again after moving into each box.
        INTERVAL_DAYS: { 1: 0, 2: 1, 3: 3, 4: 7, 5: 21 },
        MAX_BOX: 5,
        STRONG_BOX: 4,
        // "Unsure" on this many different study days (without a Known in between) drops one box.
        UNSURE_DAYS_TO_DROP: 2,

        // Mixed-up pairs: active until both kanji were cleared cleanly on the same board on this
        // many different days. While active, neither kanji can go above CONFUSION_BOX_CAP.
        CONFUSION_CLEAN_DAYS: 2,
        CONFUSION_BOX_CAP: 3,

        // Board building
        WEAK_QUOTA: 1 / 4,            // ceil(N * this) weak kanji per board (2 / 2 / 3)
        WEAK_GAP_BOARDS: 2,           // a weak kanji skips this many boards after it was shown
        WEAK_DAILY_CAP: 4,            // max times a day a kanji is shown while weak
        NEW_QUOTA_MANY: 1 / 2,        // ceil(N * this) new kanji when the weak backlog is small ...
        BACKLOG_SMALL: 1,             // ... i.e. fewer than N * this weak kanji in the pool
        NEW_QUOTA_FEW: 1,             // new kanji per board when the backlog is large ...
        BACKLOG_LARGE: 2,             // ... i.e. at least N * this weak kanji (in between: WEAK_QUOTA)
        MIN_BOARD: 3,                 // smallest board when the pool is tiny

        // Trouble list on Home
        TROUBLE_LAPSES: 3,            // fell back to weak this many times, or ...
        TROUBLE_WEAK_RUN: 6,          // ... shown this many times in a row while weak without a Known

        DAY_START_HOUR: 4,            // a study day runs 04:00 to 04:00 local time
    };

    const LEVEL_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1', 'X'];
    const GRADE = { MISSED: 0, UNSURE: 1, KNOWN: 2 };

    // ------------------------------------------------------------------ text and clashes
    // Same normalisation as norm() in tools/build_match_data.py.
    function norm(s) {
        s = String(s).toLowerCase().replace(/\(.*?\)/g, '');
        s = s.trim().replace(/^(to|a|an|the) /, '');
        return s.replace(/\s+/g, ' ').trim();
    }

    function synonymIndex(groups) {
        const idx = new Map();
        (groups || []).forEach((g, i) => g.forEach(w => {
            const k = norm(w);
            if (!idx.has(k)) idx.set(k, new Set());
            idx.get(k).add(i);
        }));
        return idx;
    }

    // Two items clash (may not share a board) if one's card text is among the other's meanings,
    // or their card texts are in the same synonym group.
    function clash(a, b, synIdx) {
        if (a.id === b.id) return true;
        const bk = new Set(b.keys), ak = new Set(a.keys);
        if (a.shown.some(x => bk.has(x)) || b.shown.some(x => ak.has(x))) return true;
        if (synIdx) {
            for (const x of a.shown) {
                const gx = synIdx.get(x);
                if (!gx) continue;
                for (const y of b.shown) {
                    const gy = synIdx.get(y);
                    if (gy) for (const g of gx) if (gy.has(g)) return true;
                }
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ study days
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    // Local date of a timestamp, with the day starting at DAY_START_HOUR.
    function studyDay(ms) {
        const d = new Date(ms - TUNING.DAY_START_HOUR * 3600 * 1000);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    function addDays(day, n) {
        const [y, m, d] = day.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d + n));
        return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
    }
    function dayDiff(a, b) {   // b - a in days
        const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
        return Math.round((p(b) - p(a)) / 86400000);
    }

    // ------------------------------------------------------------------ random
    function rng(seed) {   // mulberry32
        let a = (seed >>> 0) || 1;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function shuffle(arr, rand) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // ------------------------------------------------------------------ item states
    function band(s) {
        if (!s) return 'unseen';
        if (s.box <= 1) return 'weak';
        return s.box >= TUNING.STRONG_BOX ? 'strong' : 'learning';
    }
    function isDue(s, today) { return !!s && s.due <= today; }
    function isTrouble(s) {
        return !!s && (s.lapses >= TUNING.TROUBLE_LAPSES || (s.box === 1 && s.weakRun >= TUNING.TROUBLE_WEAK_RUN));
    }

    // Grades for one finished (or abandoned) board.
    // record = { size, ids: [...all item ids on the board], matches: [ids in clear order],
    //            wrongPairs: [{ k: id on the kanji card, a: id whose answer card was used }], abandoned }
    function gradeBoard(record) {
        const N = record.size;
        const lateM = Math.ceil(N * TUNING.LATE_FRACTION);
        const out = {};
        record.ids.forEach(id => { out[id] = { id, rank: null, m: null, kSide: 0, aSide: 0, grade: null }; });
        (record.wrongPairs || []).forEach(w => {
            if (out[w.k]) out[w.k].kSide++;
            if (out[w.a]) out[w.a].aSide++;
        });
        (record.matches || []).forEach((id, i) => {
            if (!out[id]) return;
            out[id].rank = i + 1;
            out[id].m = N - i;
        });
        Object.values(out).forEach(r => {
            if (r.kSide > 0) r.grade = GRADE.MISSED;
            else if (record.abandoned || r.rank === null) r.grade = null;   // not graded
            else if (r.aSide > 0 || r.m <= lateM) r.grade = GRADE.UNSURE;
            else r.grade = GRADE.KNOWN;
        });
        return out;
    }

    // New state for one kanji after a graded board. Pure: returns a new object.
    // cap = highest box allowed (active mixed-up pair) or null.
    function applyGrade(prev, grade, today, now, opts) {
        const T = TUNING, cap = opts && opts.cap ? opts.cap : null;
        const kSide = (opts && opts.kSide) || 0;
        const iv = b => T.INTERVAL_DAYS[b];
        let s;
        const wasWeak = !!prev && prev.box === 1;
        if (!prev) {
            s = { box: grade === GRADE.KNOWN ? 2 : 1, due: today, seen: 0, misses: 0, lapses: 0,
                  weakShows: 0, weakRun: 0, unsureDays: [], today: { day: today, weakShows: 0 },
                  lastSeen: now, lastGrade: grade, upd: now };
            s.due = addDays(today, iv(s.box));
        } else {
            s = Object.assign({}, prev, { unsureDays: (prev.unsureDays || []).slice(),
                                           today: prev.today && prev.today.day === today
                                               ? Object.assign({}, prev.today) : { day: today, weakShows: 0 } });
            if (grade === GRADE.MISSED) {
                if (s.box >= 2) s.lapses++;
                s.box = 1; s.due = today; s.unsureDays = [];
            } else if (grade === GRADE.KNOWN) {
                if (s.due <= today) {
                    s.box = Math.min(T.MAX_BOX, s.box + 1);
                    s.due = addDays(today, iv(s.box));   // the confusion cap (below) may lower both
                }
                s.unsureDays = [];
            } else if (grade === GRADE.UNSURE) {
                if (!s.unsureDays.includes(today)) s.unsureDays.push(today);
                if (s.unsureDays.length >= T.UNSURE_DAYS_TO_DROP && s.box >= 2) {
                    s.box -= 1; s.due = today; s.unsureDays = [];
                }
            }
        }
        if (cap && s.box > cap) { s.box = cap; if (s.due > addDays(today, iv(cap))) s.due = addDays(today, iv(cap)); }
        s.seen++;
        s.misses += kSide;
        s.lastSeen = now; s.lastGrade = grade; s.upd = now;
        if (wasWeak) { s.weakShows++; s.today.weakShows++; s.weakRun++; }
        if (grade === GRADE.KNOWN) s.weakRun = 0;
        return s;
    }

    // ------------------------------------------------------------------ mixed-up pairs
    function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
    function isActive(c) { return !!c && c.count > 0 && c.cleanDays.length < TUNING.CONFUSION_CLEAN_DAYS; }
    function partnersOf(confusions, id) {
        const out = [];
        for (const key in confusions) {
            const c = confusions[key];
            if (!isActive(c)) continue;
            if (c.a === id) out.push(c.b); else if (c.b === id) out.push(c.a);
        }
        return out;
    }
    function updateConfusions(prev, record, grades, today) {
        const conf = {};
        for (const k in prev) conf[k] = Object.assign({}, prev[k], { cleanDays: prev[k].cleanDays.slice() });
        const confusedNow = new Set();
        (record.wrongPairs || []).forEach(w => {
            const key = pairKey(w.k, w.a);
            const [a, b] = key.split('|');
            const c = conf[key] || (conf[key] = { a, b, count: 0, lastDay: today, cleanDays: [] });
            c.count++; c.lastDay = today; c.cleanDays = [];
            confusedNow.add(key);
        });
        if (!record.abandoned) {
            const onBoard = new Set(record.ids);
            for (const key in conf) {
                const c = conf[key];
                if (!isActive(c) || confusedNow.has(key) || !onBoard.has(c.a) || !onBoard.has(c.b)) continue;
                const ga = grades[c.a] && grades[c.a].grade, gb = grades[c.b] && grades[c.b].grade;
                if (ga === GRADE.MISSED || gb === GRADE.MISSED || ga === null || gb === null) continue;
                if (!c.cleanDays.includes(today)) c.cleanDays.push(today);
            }
        }
        return conf;
    }

    // Applies a finished or abandoned board. Returns new states (only the changed ones), the new
    // confusion map and the per-item grades.
    function applyBoard({ record, states, confusions, today, now }) {
        const grades = gradeBoard(record);
        const conf = updateConfusions(confusions || {}, record, grades, today);
        const changed = {};
        for (const id of record.ids) {
            const g = grades[id];
            if (g.grade === null) continue;
            const cap = partnersOf(conf, id).length ? TUNING.CONFUSION_BOX_CAP : null;
            changed[id] = applyGrade(states[id], g.grade, today, now, { cap, kSide: g.kSide });
        }
        return { grades, confusions: conf, changed };
    }

    // ------------------------------------------------------------------ board building
    const levelRank = lv => { const i = LEVEL_ORDER.indexOf(lv); return i < 0 ? 99 : i; };

    // opts: { pool: [items], states: {id: state}, confusions, size, mode: 'play'|'review',
    //         recent: [[ids of last board], [ids of the one before], ...], today, seed, synonyms }
    // Returns { ids, kanjiOrder, answerOrder, parts: {weak, review, new, fill}, empty }
    function buildBoard(opts) {
        const T = TUNING;
        const N = opts.size, today = opts.today, states = opts.states || {};
        const conf = opts.confusions || {};
        const rand = rng(opts.seed);
        const synIdx = opts.synIdx || synonymIndex(opts.synonyms);
        const byId = new Map(opts.pool.map(it => [it.id, it]));
        const recent = opts.recent || [];
        const inLast = n => { const s = new Set(); recent.slice(0, n).forEach(b => b.forEach(id => s.add(id))); return s; };
        const last1 = inLast(1), lastGap = inLast(T.WEAK_GAP_BOARDS);
        const st = id => states[id];
        const weakToday = id => { const s = st(id); return s && s.today && s.today.day === today ? s.today.weakShows : 0; };

        const all = opts.pool.map(it => it.id);
        const weakAll = all.filter(id => st(id) && st(id).box === 1);
        const weakSort = (a, b) => {
            const A = st(a), B = st(b);
            return (A.lastGrade === 0 ? 0 : 1) - (B.lastGrade === 0 ? 0 : 1) || B.misses - A.misses || A.lastSeen - B.lastSeen;
        };
        const weak = gap => weakAll.filter(id => !gap.has(id) && weakToday(id) < T.WEAK_DAILY_CAP).sort(weakSort);
        const overdue = id => (dayDiff(st(id).due, today) + 1) / Math.max(1, T.INTERVAL_DAYS[st(id).box]);
        const due = all.filter(id => st(id) && st(id).box >= 2 && st(id).due <= today && !last1.has(id))
            .sort((a, b) => overdue(b) - overdue(a) || st(a).lastSeen - st(b).lastSeen);
        const known = all.filter(id => st(id) && st(id).box >= 2 && st(id).due > today && !last1.has(id))
            .sort((a, b) => st(a).lastSeen - st(b).lastSeen);
        const fresh = all.filter(id => !st(id)).sort((a, b) => {
            const A = byId.get(a), B = byId.get(b);
            return levelRank(A.lv) - levelRank(B.lv) || (A.freq || 1e9) - (B.freq || 1e9) || A.strokes - B.strokes || (a < b ? -1 : 1);
        });

        const chosen = [], parts = { weak: 0, review: 0, new: 0, fill: 0 };
        const fits = id => byId.has(id) && !chosen.includes(id) && chosen.every(c => !clash(byId.get(c), byId.get(id), synIdx));
        function add(id, part) {
            if (chosen.length >= N || !fits(id)) return false;
            chosen.push(id); parts[part]++;
            for (const p of partnersOf(conf, id)) if (chosen.length < N && fits(p)) { chosen.push(p); parts[part]++; }
            return true;
        }
        function take(list, n, part) {
            let added = 0;
            for (const id of list) {
                if (added >= n || chosen.length >= N) break;
                const before = chosen.length;
                if (add(id, part)) added += chosen.length - before;
            }
        }

        const q = Math.ceil(N * T.WEAK_QUOTA);
        if (opts.mode === 'review') {
            take(weak(last1), N, 'weak');
            take(due, N, 'review');
            if (!chosen.length) return { ids: [], empty: true, parts };
            take(known, N, 'fill');
            take(all.filter(id => !last1.has(id)), N, 'fill');
            take(all, N, 'fill');
        } else {
            const backlog = weakAll.length;
            const newQuota = backlog < N * T.BACKLOG_SMALL ? Math.ceil(N * T.NEW_QUOTA_MANY)
                : backlog >= N * T.BACKLOG_LARGE ? T.NEW_QUOTA_FEW : q;
            take(weak(lastGap), q, 'weak');
            take(fresh, newQuota, 'new');
            take(due, N, 'review');
            take(known, N, 'fill');
            take(weak(last1), N, 'weak');
            take(fresh, N, 'new');
            take(all.filter(id => !last1.has(id)), N, 'fill');
            take(all, N, 'fill');
        }
        const ids = chosen.slice(0, N);
        return {
            ids, parts, empty: ids.length === 0,
            small: ids.length < N,
            kanjiOrder: shuffle(ids, rand),
            answerOrder: shuffle(ids, rand),
        };
    }

    // ------------------------------------------------------------------ scoring
    function bestKey(deck, level, includeLower, size) {
        return [deck, level, includeLower ? 'lower1' : 'lower0', size].join('|');
    }
    function isBetter(result, best) {
        if (!best) return true;
        return result.misses < best.misses || (result.misses === best.misses && result.activeMs < best.activeMs);
    }
    function firstTry(grades) {
        return Object.values(grades).filter(g => g.kSide === 0).length;
    }

    // Levels in a pool: the chosen one, plus all easier main levels if includeLower.
    // Extras (X) is only included when it's the chosen level.
    function poolLevels(level, includeLower) {
        if (!includeLower) return [level];
        const main = LEVEL_ORDER.slice(0, 5);
        if (level === 'X') return main.concat('X');
        return main.slice(0, main.indexOf(level) + 1);
    }


    // ------------------------------------------------------------------ keep going into the next level
    const MAIN_LEVELS = LEVEL_ORDER.slice(0, 5);
    function nextLevel(lv) {
        const i = MAIN_LEVELS.indexOf(lv);
        return i >= 0 && i < MAIN_LEVELS.length - 1 ? MAIN_LEVELS[i + 1] : null;
    }
    function fullySeen(items, states) { return items.length > 0 && items.every(it => !!states[it.id]); }

    // Levels in play (decision 5, R4). Base = the chosen level, plus every easier level when
    // includeEasier. With keepGoing, while the newest level in play has no unseen items, the next
    // level is added on top. levels: { lv: [items] } loaded so far. Returns { levels, added, need }:
    // need = a level that must be loaded before the answer is final (call again after loading it).
    function levelsInPlay({ level, includeEasier, keepGoing, levels, states }) {
        const base = poolLevels(level, !!includeEasier);
        const missing = base.find(lv => !levels[lv]);
        if (missing) return { levels: base, added: [], need: missing };
        const out = base.slice(), added = [];
        let lv = level;
        while (keepGoing && nextLevel(lv)) {
            if (!levels[lv]) return { levels: out, added, need: lv };
            if (!fullySeen(levels[lv], states || {})) break;
            lv = nextLevel(lv);
            if (!levels[lv]) return { levels: out, added, need: lv };
            out.push(lv); added.push(lv);
        }
        return { levels: out, added, need: null };
    }

    // "Playing: N4" / "N5–N4" / "N4 → N3" / "N5–N4 → N3".
    function playingLabel(r, names) {
        const nm = lv => (names && names[lv]) || lv;
        const base = r.levels.filter(lv => !r.added.includes(lv));
        let s = base.length > 1 ? `${nm(base[0])}–${nm(base[base.length - 1])}` : nm(base[0]);
        if (r.added.length) s += ` → ${nm(r.added[r.added.length - 1])}`;
        return s;
    }

    // Items a board draws from: every item of the levels in play. For Review, also the already-seen
    // items of every played level (unseen items of those levels never come in).
    // levels: { lv: [items] } (loaded), inPlay: [levels], played: [levels with progress].
    function poolFor({ inPlay, played, levels, states, review }) {
        const out = [], ids = new Set();
        const push = it => { if (!ids.has(it.id)) { ids.add(it.id); out.push(it); } };
        inPlay.forEach(lv => (levels[lv] || []).forEach(push));
        if (review) (played || []).forEach(lv => {
            if (!inPlay.includes(lv)) (levels[lv] || []).forEach(it => { if (states[it.id]) push(it); });
        });
        return out;
    }

    // ------------------------------------------------------------------ board sizes (decision 8)
    const SIZES = [6, 12];
    function normSize(n) { return Number(n) === 6 ? 6 : 12; }   // a saved 8 (or anything else) becomes 12

    // ------------------------------------------------------------------ keyboard play (decision 9)
    // Keys by physical position (KeyboardEvent.code), so a Japanese IME or JIS layout doesn't matter.
    const KEY_ROWS = {
        k: [['KeyQ', 'KeyW', 'KeyE', 'KeyR'], ['KeyA', 'KeyS', 'KeyD', 'KeyF'], ['KeyZ', 'KeyX', 'KeyC', 'KeyV']],
        a: [['KeyU', 'KeyI', 'KeyO', 'KeyP'], ['KeyJ', 'KeyK', 'KeyL', 'Semicolon'], ['KeyM', 'Comma', 'Period', 'Slash']],
    };
    const KEY_LABEL = { Semicolon: ';', Comma: ',', Period: '.', Slash: '/' };
    const keyLabel = code => KEY_LABEL[code] || code.replace('Key', '');
    const keyCols = n => (n <= 6 ? 3 : 4);
    // codes for the n cards of each side, in card order (rows of keyCols(n)).
    function keyMap(n) {
        const cols = keyCols(n), out = { k: [], a: [] };
        for (const side of ['k', 'a']) for (let i = 0; i < n && i < 12; i++) out[side].push(KEY_ROWS[side][Math.floor(i / cols)][i % cols]);
        return out;
    }
    // e: { code, ctrlKey, altKey, metaKey }. Returns { side: 'k'|'a', index } or null.
    function keyTarget(e, n) {
        if (!e || e.ctrlKey || e.altKey || e.metaKey) return null;
        const m = keyMap(n);
        for (const side of ['k', 'a']) { const i = m[side].indexOf(e.code); if (i >= 0) return { side, index: i }; }
        return null;
    }
    // A key press belongs to the game only when focus isn't in a text field, a dialog or the learn panel.
    function keyAllowed(target) {
        if (!target || !target.closest) return true;
        if (target.isContentEditable) return false;
        const tag = (target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
        return !target.closest('[role="dialog"], [role="alertdialog"], dialog, .learn');
    }

    return {
        TUNING, LEVEL_ORDER, GRADE,
        norm, synonymIndex, clash,
        studyDay, addDays, dayDiff, rng, shuffle,
        band, isDue, isTrouble, gradeBoard, applyGrade,
        pairKey, isActive, partnersOf, updateConfusions, applyBoard,
        buildBoard, bestKey, isBetter, firstTry, poolLevels,
        nextLevel, fullySeen, poolFor, levelsInPlay, playingLabel,
        SIZES, normSize, KEY_ROWS, keyLabel, keyCols, keyMap, keyTarget, keyAllowed,
    };
}));
