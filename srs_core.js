// Endless mode: the learning engine (pure logic, no DOM, no storage). v2 "Flow".
// Runs in the browser (window.SrsCore) and in Node for the tests (require('./srs_core.js')).
//
// It classes a typed answer (clean / slow / near miss / wrong / unknown), keeps a memory model per
// word (FSRS-6), runs the in-session learning loop (a miss comes back a few items later, then one
// confirm), picks the most useful next word every answer, adapts the pace (the working set W) and
// reports progress. Every function that depends on the time takes `now` (ms) as a parameter, so
// tests can simulate weeks. Tunables are in TUNING. The design is claude/endless-plan.md (v2).
//
// Items come from a content adapter (srs_content_kb.js; later JLPT lists):
//   { key: 'w:<text>|<reading>', text, reading, answers: [kana], altAnswers: [kana], gloss, tags, order }
// Item state (stored per key) holds only stats: see newState().
//
// The FSRS-6 formulas and default parameters are copied from ts-fsrs 6.0.1
// (https://github.com/open-spaced-repetition/ts-fsrs), used under the MIT licence:
//   MIT License. Copyright (c) 2023 Open Spaced Repetition.
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
//   and associated documentation files (the "Software"), to deal in the Software without
//   restriction, including without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions: The above copyright notice
//   and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
//   AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
//   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SrsCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

    // ------------------------------------------------------------------ tuning
    const TUNING = {
        // answers and timing (round 1)
        SLOW: 3,                    // ratio above this = slow-correct
        FAST: 0.8,                  // clean with ratio at most this, on a memory word = Easy
        DISTRACTED_MS: 60000,       // answers slower than this: no timing data, correctness only
        BASELINE_DEFAULT: 900,      // ms per mora until BASELINE_MIN clean samples exist
        BASELINE_MIN: 10,
        BASELINE_KEEP: 50,          // clean samples kept for the running median
        TYPO_EVERY: 20,             // "That was a typo": once per this many answers (across sessions)
        DAY_START_HOUR: 4,          // the study day starts at 04:00 local time
        RECENT_KEEP: 5,             // answers kept in state.recent
        CLEAN_DAYS_KEEP: 5,
        LOG_KEEP: 2000,             // answer log entries kept on the device
        // memory model and picking (v2)
        TARGET: 0.90,               // a memory word is fading when its recall probability R < TARGET
        LOST: 0.35,                 // below this it is relearned like a new word, not asked as a review
        FADING_ORDER: 'save',       // 'save': highest R below TARGET first; 'risk': lowest R first
        NEW_EVERY: 4,               // while words are fading, a new word takes every NEW_EVERY-th slot ...
        NEW_EVERY_BUSY: 8,          // ... or every 8th when more than BUSY_FADING words are fading
        BUSY_FADING: 50,
        LONG_TERM_S: 21,            // stability (days) counted as "long-term"
        GRAD_S: 30,                 // mastered: s >= GRAD_S, clean on GRAD_DAYS study days, last GRAD_LAST clean <= GRAD_RATIO
        GRAD_DAYS: 3,
        GRAD_LAST: 2,
        GRAD_RATIO: 1.5,
        // learning loop and pace (v2)
        GAP_MISS: 4,                // a miss comes back after this many other items
        GAP_CONFIRM_MIN: 8,         // the confirm comes after max(GAP_CONFIRM_MIN, W + 2) items
        MIN_GAP: 3,                 // at least this many other items before a loop word comes back
        W_START: 6, W_MIN: 3, W_MAX: 12,
        PACE_EVERY: 10,             // every this many answers, look at the last PACE_WINDOW first attempts
        PACE_WINDOW: 20,
        PACE_MIN: 10,               // ... once at least this many are recorded
        ACC_UP: 0.90,               // above: W + 1
        ACC_DOWN: 0.75,             // below: W - 1
    };
    const gapConfirm = W => Math.max(TUNING.GAP_CONFIRM_MIN, W + 2);

    // Class codes (stored in state.recent and the log)
    const CLS = { CLEAN: 'C', SLOW: 'S', NEAR: 'N', WRONG: 'W', TYPO: 'T', UNKNOWN: 'U' };

    // ------------------------------------------------------------------ kana
    const toHiragana = s => String(s).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
    const hasKanji = s => /[㐀-䶿一-鿿豈-﫿々]/.test(s);
    const SMALL = 'ぁぃぅぇぉゃゅょゎ';
    const LARGE = 'あいうえおやゆよわ';

    // Mora: small ゃゅょぁぃぅぇぉゎ join the kana before them; っ, ん and ー count.
    function moraCount(kana) {
        let n = 0;
        for (const c of Array.from(toHiragana(kana))) if (!SMALL.includes(c)) n++;
        return Math.max(1, n);
    }

    // Kana -> romaji (Hepburn as an IME user types it; ぢ = di, づ = du, を = wo), so the
    // "keyboard slip" test sees the keys that were typed. Own table: no wanakana in Node.
    const ROWS = {
        '': 'あいうえお', k: 'かきくけこ', s: 'さしすせそ', t: 'たちつてと', n: 'なにぬねの', h: 'はひふへほ',
        m: 'まみむめも', r: 'らりるれろ', g: 'がぎぐげご', z: 'ざじずぜぞ', d: 'だぢづでど', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ',
    };
    const K2R = {};
    for (const [cons, row] of Object.entries(ROWS)) Array.from(row).forEach((c, i) => { K2R[c] = cons + 'aiueo'[i]; });
    Object.assign(K2R, {
        し: 'shi', ち: 'chi', つ: 'tsu', ふ: 'fu', じ: 'ji', ぢ: 'di', づ: 'du',
        や: 'ya', ゆ: 'yu', よ: 'yo', わ: 'wa', を: 'wo', ん: 'n', ゔ: 'vu', ー: '-',
        ぁ: 'xa', ぃ: 'xi', ぅ: 'xu', ぇ: 'xe', ぉ: 'xo', ゃ: 'xya', ゅ: 'xyu', ょ: 'xyo', ゎ: 'xwa', っ: 'xtsu',
    });
    // two-kana combinations
    const YOON_BASE = { き: 'ky', ぎ: 'gy', に: 'ny', ひ: 'hy', び: 'by', ぴ: 'py', み: 'my', り: 'ry',
                        し: 'sh', じ: 'j', ち: 'ch', ぢ: 'dy' };
    for (const [k, r] of Object.entries(YOON_BASE)) {
        K2R[k + 'ゃ'] = r + 'a'; K2R[k + 'ゅ'] = r + 'u'; K2R[k + 'ょ'] = r + 'o';
    }
    Object.assign(K2R, {
        しぇ: 'she', じぇ: 'je', ちぇ: 'che', ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo',
        てぃ: 'thi', でぃ: 'dhi', とぅ: 'twu', どぅ: 'dwu', うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
        ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo', いぇ: 'ye',
    });

    function kanaToRomaji(kana) {
        const s = Array.from(toHiragana(kana));
        let out = '', sokuon = false;
        for (let i = 0; i < s.length; i++) {
            let r, step = 1;
            if (i + 1 < s.length && K2R[s[i] + s[i + 1]]) { r = K2R[s[i] + s[i + 1]]; step = 2; }
            else if (s[i] === 'っ' && i + 1 < s.length) { sokuon = true; continue; }
            else r = K2R[s[i]] !== undefined ? K2R[s[i]] : s[i];
            if (sokuon) { out += r.startsWith('ch') ? 'c' : (/^[a-z]/.test(r) && !/^[aiueon]/.test(r) ? r[0] : ''); sokuon = false; }
            if (out.endsWith('n') && s[i - 1] === 'ん' && /^[aiueoy]/.test(r)) out += "'";   // ん before a vowel or y: n'
            out += r;
            i += step - 1;
        }
        return out;
    }

    // Romaji -> kana for leftover romaji in an answer. Only unambiguous spellings: a final lone
    // "n" is NOT converted (the trailing-n rule handles answers that end in ん).
    const R2K = {};
    for (const [k, r] of Object.entries(K2R)) if (!(r in R2K) && r !== 'n' && r !== '-') R2K[r] = k;
    Object.assign(R2K, {
        si: 'し', ti: 'ち', tu: 'つ', hu: 'ふ', zi: 'じ', di: 'ぢ', du: 'づ', wo: 'を',
        sya: 'しゃ', syu: 'しゅ', syo: 'しょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ', cya: 'ちゃ', cyu: 'ちゅ', cyo: 'ちょ',
        zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
        la: 'ぁ', li: 'ぃ', lu: 'ぅ', le: 'ぇ', lo: 'ぉ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ',
        xtu: 'っ', ltu: 'っ', ltsu: 'っ', nn: 'ん', "n'": 'ん', '-': 'ー',
    });
    function romajiToKana(text) {
        const s = String(text).toLowerCase();
        let out = '', i = 0;
        while (i < s.length) {
            const c = s[i];
            if (!/[a-z'\-]/.test(c)) { out += c; i++; continue; }
            // doubled consonant (not n) -> っ
            if (/[bcdfghjkmpqrstvwxyz]/.test(c) && s[i + 1] === c) { out += 'っ'; i++; continue; }
            if (c === 't' && s.startsWith('tch', i)) { out += 'っ'; i++; continue; }
            // "nn" + vowel/y is ん + な行 (はんにち = hannichi), as the IME reads it
            if (c === 'n' && s[i + 1] === 'n' && /[aiueoy]/.test(s[i + 2] || '')) { out += 'ん'; i++; continue; }
            // n before a consonant (not y) -> ん
            if (c === 'n' && i + 1 < s.length && /[bcdfghjkmpqrstvwz]/.test(s[i + 1])) { out += 'ん'; i++; continue; }
            let hit = null;
            for (let len = 4; len >= 1; len--) {
                const part = s.substr(i, len);
                if (part.length === len && R2K[part]) { hit = part; break; }
            }
            if (!hit) return null;     // can't convert unambiguously
            out += R2K[hit];
            i += hit.length;
        }
        return out;
    }

    // ------------------------------------------------------------------ normalising and classing
    // Input: trim, full-width -> half-width (NFKC), katakana -> hiragana, trailing romaji n -> ん
    // when the answer ends in ん, then leftover romaji -> kana where unambiguous.
    function normalize(raw, expected) {
        let s = String(raw == null ? '' : raw).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
        s = toHiragana(s);
        let trailingN = false;
        const endsInN = (expected || []).some(e => toHiragana(e).endsWith('ん'));
        if (endsInN && /[^n]n$/.test(s) || (endsInN && s === 'n')) { s = s.slice(0, -1) + 'ん'; trailingN = true; }
        if (/[a-z]/.test(s)) {
            const k = romajiToKana(s);
            if (k !== null && !/[a-z]/.test(k)) s = k;
        }
        return { kana: s, trailingN };
    }

    // Vowel of a (large, plain) kana, for the long-vowel fold
    function vowelOf(c) {
        const r = K2R[c];
        return r ? r[r.length - 1] : '';
    }
    // The never-a-typo differences: っ, long vowels, ゛゜, small vs large ゃゅょ, ん.
    // Two spellings that become equal once these are folded away differ by a real reading error.
    function foldReading(s) {
        let t = toHiragana(s).replace(/っ/g, '').replace(/ん/g, '');
        t = t.normalize('NFD').replace(/[゙゚]/g, '').normalize('NFC');
        t = Array.from(t).map(c => { const i = SMALL.indexOf(c); return i >= 0 ? LARGE[i] : c; }).join('');
        let out = '', last = '';
        for (const c of Array.from(t)) {
            if (c === 'ー') continue;                                  // ー lengthens the vowel before it
            const isVowel = 'あいうえお'.includes(c), v = vowelOf(c);
            if (isVowel && last && (v === last || (c === 'う' && last === 'o') || (c === 'い' && last === 'e'))) continue;
            out += c;
            last = v || last;
        }
        return out;
    }
    function isRealReadingError(given, expected) {
        if (/[a-z]/.test(given)) return false;
        return given !== expected && foldReading(given) === foldReading(expected);
    }

    // QWERTY neighbours (same row and the diagonals)
    const KB_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    const NEIGHBOURS = {};
    KB_ROWS.forEach((row, r) => Array.from(row).forEach((c, i) => {
        const n = new Set([row[i - 1], row[i + 1]]);
        if (r === 0) { n.add(KB_ROWS[1][i - 1]); n.add(KB_ROWS[1][i]); }
        if (r === 1) { n.add(KB_ROWS[0][i]); n.add(KB_ROWS[0][i + 1]); n.add(KB_ROWS[2][i - 1]); n.add(KB_ROWS[2][i]); }
        if (r === 2) { n.add(KB_ROWS[1][i]); n.add(KB_ROWS[1][i + 1]); }
        n.delete(undefined);
        NEIGHBOURS[c] = n;
    }));
    const isNeighbour = (a, b) => !!(NEIGHBOURS[a] && NEIGHBOURS[a].has(b));

    // Damerau (optimal string alignment) distance where a substitution of non-neighbouring keys costs 2.
    function slipDistance(a, b) {
        const m = a.length, n = b.length;
        const d = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const sub = a[i - 1] === b[j - 1] ? 0 : (isNeighbour(a[i - 1], b[j - 1]) ? 1 : 2);
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub);
                if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
        return d[m][n];
    }
    // One keyboard slip: distance exactly 1 on the romaji forms (0 = same keys, different kana:
    // e.g. じ/ぢ, which is a reading error).
    function isKeySlip(given, expected) {
        return slipDistance(kanaToRomaji(given), kanaToRomaji(expected)) === 1;
    }

    function expectedOf(item) {
        return [...(item.answers || []), ...(item.altAnswers || [])].map(toHiragana);
    }

    function median(xs) {
        if (!xs.length) return null;
        const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
        return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
    }
    function baselineOf(samples) {
        return samples && samples.length >= TUNING.BASELINE_MIN ? median(samples) : TUNING.BASELINE_DEFAULT;
    }
    function updateBaseline(samples, msPerMora) {
        const out = [...(samples || []), msPerMora];
        while (out.length > TUNING.BASELINE_KEEP) out.shift();
        return out;
    }

    // -> { cls, ratio, kana, matched, mora, distracted, paused, trailingN }
    // timing: { ms, paused, baseline (ms per mora), firstSight }
    // An empty answer on a word's first-ever prompt is U ("I don't know it yet"); later it is W.
    function classify(item, input, timing = {}) {
        const expected = expectedOf(item);
        const { kana, trailingN } = normalize(input, expected);
        if (!kana && timing.firstSight) {
            return { kana, matched: null, mora: moraCount(toHiragana(item.reading || expected[0] || '')), ratio: null,
                     distracted: false, paused: !!timing.paused, trailingN, cls: CLS.UNKNOWN };
        }
        const ms = timing.ms;
        const distracted = typeof ms === 'number' && ms > TUNING.DISTRACTED_MS;
        const matched = kana ? expected.find(e => e === kana) || null : null;
        const mora = moraCount(matched || toHiragana(item.reading || expected[0] || ''));
        const ratio = (typeof ms === 'number' && !distracted) ? ms / ((timing.baseline || TUNING.BASELINE_DEFAULT) * mora) : null;
        const res = { kana, matched, mora, ratio, distracted, paused: !!timing.paused, trailingN };
        if (matched) {
            if (distracted) res.cls = CLS.CLEAN;                       // judged on correctness alone
            else if (timing.paused || (ratio !== null && ratio > TUNING.SLOW)) res.cls = CLS.SLOW;
            else res.cls = CLS.CLEAN;
            return res;
        }
        res.cls = kana && expected.some(e => !isRealReadingError(kana, e) && isKeySlip(kana, e)) ? CLS.NEAR : CLS.WRONG;
        return res;
    }

    // ------------------------------------------------------------------ days
    // The study day starts at DAY_START_HOUR (local), so a session past midnight is one day.
    function localDay(ms) {
        const d = new Date(ms - TUNING.DAY_START_HOUR * HOUR);
        const p = n => (n < 10 ? '0' : '') + n;
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    // End of the current study day (ms): the next DAY_START_HOUR
    function dayEnd(ms) {
        const d = new Date(ms - TUNING.DAY_START_HOUR * HOUR);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 1);
        return d.getTime() + TUNING.DAY_START_HOUR * HOUR;
    }

    // ------------------------------------------------------------------ FSRS-6 (copied from ts-fsrs 6.0.1)
    const FSRS_W = Object.freeze([0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
        1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]);
    const S_MIN = 0.001, S_MAX = 36500;
    const GRADE = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
    const roundTo = (x, n) => { const f = 10 ** n; return Math.round(x * f) / f; };
    const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
    const DECAY = -FSRS_W[20];
    const FACTOR = roundTo(Math.exp(Math.pow(DECAY, -1) * Math.log(0.9)) - 1, 8);

    function forgettingCurve(t, s) { return roundTo(Math.pow(1 + FACTOR * t / s, DECAY), 8); }
    function initStability(g) { return clamp(FSRS_W[g - 1], S_MIN, S_MAX); }
    function initDifficulty(g) { return roundTo(FSRS_W[4] - Math.exp((g - 1) * FSRS_W[5]) + 1, 8); }
    function nextDifficulty(d, g) {
        const delta = -FSRS_W[6] * (g - 3);
        const next = d + roundTo(delta * (10 - d) / 9, 8);
        return clamp(roundTo(FSRS_W[7] * initDifficulty(GRADE.EASY) + (1 - FSRS_W[7]) * next, 8), 1, 10);
    }
    function recallStability(d, s, r, g) {
        const w = FSRS_W;
        const hard = g === GRADE.HARD ? w[15] : 1, easy = g === GRADE.EASY ? w[16] : 1;
        return roundTo(clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy), S_MIN, S_MAX), 8);
    }
    function forgetStability(d, s, r) {
        const w = FSRS_W;
        return roundTo(clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX), 8);
    }
    function shortTermStability(s, g) {
        const w = FSRS_W;
        const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
        return roundTo(clamp(s * (g >= GRADE.HARD ? Math.max(sinc, 1) : sinc), S_MIN, S_MAX), 8);
    }
    // First review of a word: { s, d }
    function fsrsInit(g) { return { s: initStability(g), d: clamp(initDifficulty(g), 1, 10) }; }
    // One review: mem { s, d }, t elapsed days, g grade, shortTerm (same study day) -> { s, d }.
    // Same as ts-fsrs FSRS6Algorithm.next_state with t = 0 for a same-day review.
    function fsrsStep(mem, t, g, shortTerm) {
        const { s, d } = mem;
        let ns;
        if (shortTerm) ns = shortTermStability(s, g);
        else {
            const r = forgettingCurve(t, s);
            if (g === GRADE.AGAIN) {
                const after = forgetStability(d, s, r);
                ns = clamp(roundTo(s / Math.exp(FSRS_W[17] * FSRS_W[18]), 8), S_MIN, after);
            } else ns = recallStability(d, s, r, g);
        }
        return { s: ns, d: nextDifficulty(d, g) };
    }
    // Recall probability of a word now (0 for a word never answered)
    function recall(state, now) {
        if (!state || !state.s) return 0;
        return forgettingCurve(Math.max(0, now - state.lr) / DAY, state.s);
    }
    // FSRS update of a stored state at `now`: same study day -> short-term formula
    function fsrsNext(state, g, now) {
        if (!state || !state.s) return fsrsInit(g);
        const same = localDay(state.lr) === localDay(now);
        return fsrsStep({ s: state.s, d: state.d }, same ? 0 : Math.max(0, now - state.lr) / DAY, g, same);
    }

    // Grade from the answer class (no buttons). firstSight: the word's first-ever prompt.
    function gradeFor(cls, ratio, opts = {}) {
        if (cls === CLS.WRONG || cls === CLS.UNKNOWN) return GRADE.AGAIN;
        if (cls === CLS.SLOW || cls === CLS.NEAR || cls === CLS.TYPO) return GRADE.HARD;
        if (opts.firstSight) return GRADE.EASY;                         // known already: straight to memory
        if (opts.memory && ratio !== null && ratio !== undefined && ratio <= TUNING.FAST) return GRADE.EASY;
        return GRADE.GOOD;                                              // including a distracted clean answer
    }

    // ------------------------------------------------------------------ word state
    // st: 'learning' | 'memory' (new words have no record)
    function newState() {
        return { st: 'learning', s: 0, d: 0, lr: 0, reps: 0, lapses: 0, seen: 0, correct: 0,
                 cleanDays: [], recent: [], ft: false, grad: null, last: 0 };
    }
    const STATE_FIELDS = Object.keys(newState());
    const isRight = c => c === CLS.CLEAN || c === CLS.SLOW;
    const isPass = c => c === CLS.CLEAN || c === CLS.SLOW || c === CLS.NEAR || c === CLS.TYPO;   // moves the loop on

    function checkMastered(s) {
        if (s.st !== 'memory' || s.s < TUNING.GRAD_S || s.cleanDays.length < TUNING.GRAD_DAYS) return false;
        const last = s.recent.slice(-TUNING.GRAD_LAST);
        return last.length === TUNING.GRAD_LAST &&
            last.every(([c, r]) => c === CLS.CLEAN && r !== null && r <= TUNING.GRAD_RATIO);
    }

    // One answer. prev: state or null (new word); cls: C/S/N/T/W/U;
    // ctx: { ratio, loop: null | { need: 'retry'|'confirm' } } (the word's learning-loop entry, if any)
    // -> { state, grade, R (recall before the answer), action: null | 'retry' | 'confirm' | 'leave',
    //      retype (show the answer and ask for a retype), fastTrack, relearn, mastered }
    function applyAnswer(prev, cls, now, ctx = {}) {
        const firstSight = !prev;
        const s = Object.assign(newState(), prev ? JSON.parse(JSON.stringify(prev)) : {});
        const ratio = ctx.ratio === undefined ? null : ctx.ratio;
        const loop = ctx.loop || null;
        const wasMemory = !firstSight && s.st === 'memory' && !loop;
        const R = firstSight ? 0 : recall(s, now);
        let g = gradeFor(cls, ratio, { firstSight, memory: wasMemory });
        // Same study day: never Easy (FSRS's short-term Easy multiplies stability ~1.8x per answer, which would
        // let fast drilling in one sitting inflate a word); Good plateaus at ~2 days.
        if (!firstSight && g === GRADE.EASY && localDay(s.lr) === localDay(now)) g = GRADE.GOOD;
        const mem = fsrsNext(firstSight ? null : s, g, now);
        s.s = mem.s; s.d = mem.d; s.lr = now; s.reps++;
        s.seen++; s.last = now;
        s.recent.push([cls, ratio === null ? null : Math.round(ratio * 100) / 100]);
        while (s.recent.length > TUNING.RECENT_KEEP) s.recent.shift();
        if (isRight(cls)) s.correct++;
        if (cls === CLS.CLEAN) {
            const day = localDay(now);
            if (!s.cleanDays.includes(day)) s.cleanDays.push(day);
            while (s.cleanDays.length > TUNING.CLEAN_DAYS_KEEP) s.cleanDays.shift();
        }
        const out = { state: s, grade: g, R, action: null, retype: false, fastTrack: false, relearn: false, mastered: false };

        if (firstSight) {
            if (isRight(cls)) { s.st = 'memory'; s.ft = true; out.fastTrack = true; }            // known already
            else { s.st = 'learning'; out.action = 'retry'; out.retype = cls === CLS.WRONG || cls === CLS.UNKNOWN; }
        } else if (loop) {
            if (!isPass(cls)) { s.st = 'learning'; out.action = 'retry'; out.retype = true; }
            else if (loop.need === 'retry') { out.action = 'confirm'; }
            else { s.st = 'memory'; out.action = 'leave'; }
        } else if (cls === CLS.WRONG || cls === CLS.UNKNOWN) {                                  // a memory word missed
            s.st = 'learning'; s.lapses++; s.grad = null; s.ft = false;
            out.action = 'retry'; out.retype = true; out.relearn = true;
        } else if (s.st === 'learning') {
            // a learning word answered outside the loop (session ended mid-loop): pass -> confirm
            out.action = isPass(cls) ? 'confirm' : 'retry';
        }
        if (cls === CLS.WRONG) s.grad = null;
        if (s.grad === null && checkMastered(s)) { s.grad = now; out.mastered = true; }
        return out;
    }

    // Evidence from the class modes (phase 2b): a typed word → reading answer outside endless.
    // correct -> Good (no timing, so never Easy); wrong -> Again (a lapse on a memory word). Same-day rules
    // as usual. A correct answer on a word with no record creates a memory record (ft not set); a wrong one
    // creates nothing. No loop entry, and nothing about pace, typo, baseline or answer counts changes here.
    // cleanDays and recent stay as they are (no timing: mastery needs timed clean answers).
    // -> { state, grade, R } or null (nothing to record)
    function applyExternal(prev, correct, now) {
        if (!prev && !correct) return null;
        const g = correct ? GRADE.GOOD : GRADE.AGAIN;
        const s = Object.assign(newState(), prev ? JSON.parse(JSON.stringify(prev)) : {});
        const R = prev ? recall(prev, now) : 0;
        const mem = fsrsNext(prev || null, g, now);
        s.s = mem.s; s.d = mem.d; s.lr = now; s.reps++; s.seen++; s.last = now;
        if (!prev) s.st = 'memory';
        if (correct) s.correct++;
        else { if (s.st === 'memory') s.lapses++; s.grad = null; }
        return { state: s, grade: g, R };
    }

    // ------------------------------------------------------------------ session, loop and picking
    // sess.loop: [{ key, at, need }] — a loop word is due back when sess.n >= at
    function newSession(W) {
        return { n: 0, recentKeys: [], loop: [], sinceNew: 0, W: W || TUNING.W_START };
    }
    const inLoop = (sess, key) => sess.loop.find(e => e.key === key) || null;

    function fadingList(items, states, sess, now) {
        const out = [];
        for (const it of items) {
            const s = states[it.key];
            if (!s || s.st !== 'memory' || inLoop(sess, it.key)) continue;
            const R = recall(s, now);
            if (R < TUNING.TARGET && R >= TUNING.LOST) out.push({ it, R });
        }
        out.sort(TUNING.FADING_ORDER === 'risk' ? (a, b) => a.R - b.R : (a, b) => b.R - a.R);
        return out;
    }

    // -> { item, kind: 'loop'|'fading'|'relearn'|'new'|'review'|'wait', loop: entry|null }; null only for an empty pool
    function pickNext(items, states, sess, now) {
        if (!items.length) return null;
        const lastKey = sess.recentKeys[sess.recentKeys.length - 1];
        const ok = k => k !== lastKey;
        const byKey = new Map(items.map(it => [it.key, it]));
        const loopKeys = new Set(sess.loop.map(e => e.key));
        const room = sess.loop.length < sess.W;

        // 1. a loop word whose gap has arrived
        const ready = sess.loop.filter(e => e.at <= sess.n && ok(e.key) && byKey.has(e.key)).sort((a, b) => a.at - b.at)[0];
        if (ready) return { item: byKey.get(ready.key), kind: 'loop', loop: ready };

        // candidates for a "new" slot: lost memory words (relearned like new words) first, then new words
        const newSlot = () => {
            if (!room) return null;
            let lost = null, lostR = 2;
            for (const it of items) {
                const s = states[it.key];
                if (!s || s.st !== 'memory' || loopKeys.has(it.key) || !ok(it.key)) continue;
                const R = recall(s, now);
                if (R < TUNING.LOST && R < lostR) { lost = it; lostR = R; }
            }
            if (lost) return { item: lost, kind: 'relearn', loop: null };
            const fresh = items.find(it => !states[it.key] && ok(it.key));
            return fresh ? { item: fresh, kind: 'new', loop: null } : null;
        };

        // 2. fading words, with a new word every NEW_EVERY-th slot
        const fading = fadingList(items, states, sess, now).filter(x => ok(x.it.key));
        if (fading.length) {
            const every = fading.length > TUNING.BUSY_FADING ? TUNING.NEW_EVERY_BUSY : TUNING.NEW_EVERY;
            if (sess.sinceNew >= every - 1) { const n = newSlot(); if (n) return n; }
            return { item: fading[0].it, kind: 'fading', loop: null };
        }
        // 3. a new word (or a lost one) if the working set has room
        const n = newSlot();
        if (n) return n;
        // 4./5. light practice: the memory word with the lowest R (lost words wait for room in the loop);
        //       else the loop word that has waited longest
        let low = null, lowR = 2;
        for (const it of items) {
            const s = states[it.key];
            if (!s || s.st !== 'memory' || loopKeys.has(it.key) || !ok(it.key)) continue;
            const R = recall(s, now);
            if (R >= TUNING.LOST && R < lowR) { low = it; lowR = R; }
        }
        if (low) return { item: low, kind: 'review', loop: null };
        const wait = sess.loop.filter(e => ok(e.key) && byKey.has(e.key)).sort((a, b) => a.at - b.at)[0];
        if (wait) return { item: byKey.get(wait.key), kind: 'wait', loop: wait };
        // anything that isn't the last item (tiny pools)
        const any = items.find(it => ok(it.key)) || items[0];
        const e = inLoop(sess, any.key);
        return { item: any, kind: e ? 'wait' : (states[any.key] ? 'review' : 'new'), loop: e };
    }

    // Put a word (back) into the loop after an answer given at answer index `base` (sess.n after it).
    function placeLoop(sess, key, action, base) {
        sess.loop = sess.loop.filter(e => e.key !== key);
        if (action === 'retry') sess.loop.push({ key, at: base + Math.max(TUNING.GAP_MISS, TUNING.MIN_GAP), need: 'retry' });
        else if (action === 'confirm') sess.loop.push({ key, at: base + Math.max(gapConfirm(sess.W), TUNING.MIN_GAP), need: 'confirm' });
    }

    // After an answer: move the session on. pick: what pickNext returned; res: what applyAnswer returned.
    function recordAnswer(sess, pick, res) {
        const key = pick.item.key;
        sess.n++;
        sess.recentKeys.push(key);
        while (sess.recentKeys.length > 3) sess.recentKeys.shift();
        if (pick.kind === 'new' || pick.kind === 'relearn') sess.sinceNew = 0; else sess.sinceNew++;
        placeLoop(sess, key, res.action, sess.n);
        return sess;
    }

    // ------------------------------------------------------------------ pace (working set W)
    // Counted answers: every answer except a word's first-ever sight (not knowing a new word is expected).
    const paceCounts = pick => pick.kind !== 'new';
    // meta: { W, accWindow: [bool], answerCount } (answerCount already includes this answer) -> new { W, accWindow }
    function updatePace(meta, counted, correct) {
        const acc = (meta.accWindow || []).slice();
        if (counted) { acc.push(!!correct); while (acc.length > TUNING.PACE_WINDOW) acc.shift(); }
        let W = typeof meta.W === 'number' ? meta.W : TUNING.W_START;
        if (meta.answerCount % TUNING.PACE_EVERY === 0 && acc.length >= TUNING.PACE_MIN) {
            const rate = acc.filter(Boolean).length / acc.length;
            if (rate > TUNING.ACC_UP) W = Math.min(TUNING.W_MAX, W + 1);
            else if (rate < TUNING.ACC_DOWN) W = Math.max(TUNING.W_MIN, W - 1);
        }
        return { W, accWindow: acc };
    }

    // ------------------------------------------------------------------ "That was a typo"
    // Allowed for the answer just given (near miss or wrong), once per TYPO_EVERY answers across sessions.
    // meta.answerCount counts every answer; meta.typoLastAt is the answerCount when it was last used.
    function canTypo(meta, last) {
        if (!last || last.typoUsed || (last.cls !== CLS.NEAR && last.cls !== CLS.WRONG)) return false;
        const at = meta && typeof meta.typoLastAt === 'number' ? meta.typoLastAt : null;
        return at === null || (meta.answerCount - at) >= TUNING.TYPO_EVERY;
    }
    // Re-run the last answer as a near miss from the state before it.
    // last: { prevState, now, ctx, pick, answeredAt (sess.n after the answer) }
    function applyTypo(sess, last) {
        const r = applyAnswer(last.prevState, CLS.TYPO, last.now, last.ctx);
        placeLoop(sess, last.pick.item.key, r.action, last.answeredAt);
        return r;
    }

    // ------------------------------------------------------------------ progress
    function goodStop(items, states, sess, now) {
        return sess.loop.length === 0 && fadingList(items, states, sess, now).length === 0;
    }
    function recallNow(items, states, now) {
        let sum = 0;
        for (const it of items) { const s = states[it.key]; if (s) sum += recall(s, now); }
        return sum;
    }
    const BANDS = [[0, 1, '< 1 d'], [1, 7, '1–7 d'], [7, 21, '7–21 d'], [21, 60, '21–60 d'], [60, Infinity, '60 d +']];
    // tag: optional (e.g. 'kb:step7'); log entries { k, c, ms, m, f }
    function progress(items, states, log, now, tag) {
        const pool = tag ? items.filter(it => (it.tags || []).includes(tag)) : items;
        const keys = new Set(pool.map(it => it.key));
        let recallSum = 0, longTerm = 0, mastered = 0, learning = 0, notStarted = 0, fading = 0, memory = 0;
        const bands = BANDS.map(() => 0);
        for (const it of pool) {
            const s = states[it.key];
            if (!s) { notStarted++; continue; }
            const R = recall(s, now);
            recallSum += R;
            if (s.st === 'learning') learning++; else memory++;
            if (s.st === 'memory' && R < TUNING.TARGET) fading++;
            if (s.s >= TUNING.LONG_TERM_S) longTerm++;
            if (s.grad !== null) mastered++;
            bands[BANDS.findIndex(([lo, hi]) => s.s >= lo && s.s < hi)]++;
        }
        // T marks a typo fix and f: 'x' an answer in another mode: neither counts for accuracy or speed
        const entries = (log || []).filter(e => keys.has(e.k) && e.c !== CLS.TYPO && e.f !== 'x');
        const right = entries.filter(e => e.c === CLS.CLEAN || e.c === CLS.SLOW).length;
        const graded = entries.filter(e => e.c !== CLS.UNKNOWN);
        const speeds = entries.filter(e => e.c === CLS.CLEAN && typeof e.ms === 'number' && e.m && !e.f).map(e => e.ms / e.m);
        return { total: pool.length, recallNow: Math.round(recallSum), recallExact: recallSum, longTerm, mastered, learning,
                 memory, notStarted, fading, bands, bandLabels: BANDS.map(b => b[2]),
                 answers: graded.length, accuracy: graded.length ? right / graded.length : null,
                 medianMsPerMora: median(speeds) };
    }

    // ------------------------------------------------------------------ errors that teach
    // A wrong answer that is the reading of another pool word sharing a kanji (or the spelling).
    function confusedWith(item, kana, items) {
        if (!kana) return null;
        const mine = new Set(Array.from(item.text || '').filter(c => hasKanji(c)));
        for (const o of items) {
            if (o.key === item.key) continue;
            const readings = [...(o.answers || []), ...(o.altAnswers || [])].map(toHiragana);
            if (!readings.includes(kana)) continue;
            if (o.text === item.text || Array.from(o.text || '').some(c => mine.has(c))) return o;
        }
        return null;
    }

    return {
        TUNING, CLS, GRADE, MIN, HOUR, DAY, STATE_FIELDS, FSRS_W, S_MIN, S_MAX,
        toHiragana, hasKanji, moraCount, kanaToRomaji, romajiToKana, normalize, foldReading,
        isRealReadingError, isKeySlip, slipDistance, isNeighbour, classify, median, baselineOf, updateBaseline,
        localDay, dayEnd, gapConfirm,
        forgettingCurve, fsrsInit, fsrsStep, fsrsNext, recall, gradeFor,
        newState, checkMastered, applyAnswer, applyExternal, newSession, inLoop, fadingList, pickNext, placeLoop, recordAnswer,
        paceCounts, updatePace, canTypo, applyTypo, goodStop, recallNow, progress, confusedWith,
    };
}));
