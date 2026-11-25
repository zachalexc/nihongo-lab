// Endless mode: content adapter for the public JLPT word lists (phase 4).
// Loads jlpt_words.json (N5–N1) and, on opt-in, jlpt_beyond.json (common words beyond the lists), both built by
// build_jlpt_words.py from JMdict, JmdictFurigana, the Tanos JLPT lists and wordfreq (CC BY-SA 4.0; see JLPT_DATA.md),
// and turns their rows into engine items, the same shape as srs_content_kb.js:
//   { key: 'w:<text>|<reading>', text, reading, answers, altAnswers, gloss, split, level, zipf, tags, order, src }
// Keys follow SrsContentKB.keyOf exactly, so a class word and the same JLPT word share one progress record.
// The files hold no class information; linking happens only through the key, at run time.
// Loading is lazy (first JLPT session); the service worker keeps the files in its own 'nl-data' cache.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SrsContentJLPT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ?v= of each data file: the first 8 hex digits of its sha256 (test_srs.js checks them). Change with every rebuild.
    const VERSIONS = { words: 'c3978495', beyond: 'c0914014' };
    // what the Beyond tick-box says before the file is loaded (test_srs.js checks it against the file)
    const BEYOND_INFO = { words: 3620, gzipKB: 120 };
    const FILES = { words: 'jlpt_words.json', beyond: 'jlpt_beyond.json' };
    const FIELDS = ['t', 'r', 'alt', 'split', 'gloss', 'lv', 'zipf', 'common'];
    const BEYOND_ORDER = 100000;                 // beyond words come after every N5–N1 word in content order

    const toHira = s => String(s).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
    const hasKanji = s => /[㐀-䶿一-鿿豈-﫿々]/.test(s);
    const keyOf = (text, reading) => 'w:' + text + '|' + reading;          // = SrsContentKB.keyOf
    const urlOf = (which, base) => (base || '') + FILES[which] + '?v=' + VERSIONS[which];

    // 'ruby:rt;kana;…' -> [[text, rt]] (rt is '' on kana parts), the shape endless.js readingHtml() reads
    function decodeSplit(s) {
        if (!s) return null;
        return s.split(';').map(seg => { const i = seg.indexOf(':'); return i < 0 ? [seg, ''] : [seg.slice(0, i), seg.slice(i + 1)]; });
    }

    function badFormat(msg) { const e = new Error('JLPT word list: ' + msg); e.bad = true; return e; }

    // doc: the parsed file; beyond: true for jlpt_beyond.json -> items (in file order = content order)
    function itemsFromDoc(doc, beyond) {
        if (!doc || doc.v !== 1 || !Array.isArray(doc.rows) || JSON.stringify(doc.fields) !== JSON.stringify(FIELDS)) throw badFormat('unknown format');
        const base = beyond ? BEYOND_ORDER : 0;
        return doc.rows.map(([t, r, alt, split, gloss, lv, zipf], i) => {
            const main = toHira(r);
            return {
                key: keyOf(t, r),
                text: t,
                reading: r,
                answers: [main],
                altAnswers: alt ? alt.split(',').filter(a => a && a !== main) : [],
                gloss: gloss || '',
                split: decodeSplit(split),
                level: lv || null,
                zipf: zipf / 100,
                tags: [lv ? 'jlpt:n' + lv : 'jlpt:beyond'],
                order: base + i,
                src: null,
            };
        });
    }

    // Memoised per file. A failed load is forgotten, so calling again retries. Rejects with { offline: true } when the
    // file can't be fetched (no network on first use) and { bad: true } when it isn't a word list.
    const memo = {};
    function loadFile(which, opts = {}) {
        if (!FILES[which]) return Promise.reject(badFormat('no file ' + which));
        if (memo[which]) return memo[which];
        const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
        const p = Promise.resolve()
            .then(() => {
                if (!doFetch) throw Object.assign(new Error('no fetch'), { offline: true });
                return doFetch(urlOf(which, opts.base));
            })
            .then(res => {
                if (!res || !res.ok) throw Object.assign(new Error('JLPT word list: HTTP ' + (res && res.status)), { offline: true, status: res && res.status });
                return res.json().catch(() => { throw badFormat('not JSON'); });
            }, e => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { offline: true }); })
            .then(doc => itemsFromDoc(doc, which === 'beyond'));
        memo[which] = p;
        p.catch(() => { if (memo[which] === p) delete memo[which]; });
        return p;
    }

    // -> Promise<{ items, words, beyond }>: N5–N1 items, then the beyond items when opts.beyond
    function load(opts = {}) {
        const parts = [loadFile('words', opts)];
        if (opts.beyond) parts.push(loadFile('beyond', opts));
        return Promise.all(parts).then(([w, b]) => ({ items: b ? w.concat(b) : w, words: w.length, beyond: b ? b.length : 0 }));
    }

    function _reset() { for (const k of Object.keys(memo)) delete memo[k]; }

    return { VERSIONS, BEYOND_INFO, FILES, FIELDS, BEYOND_ORDER, urlOf, load, loadFile, itemsFromDoc, decodeSplit, keyOf, hasKanji, toHira, _reset };
}));
