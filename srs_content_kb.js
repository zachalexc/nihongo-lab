// Endless mode: content adapter for the class words (Kanji Basic 1 + 2).
// Turns the class words chosen by KB1Core.selectWords() (from the decrypted kb1 bundle, in
// memory only) into engine items. Later srs_content_jlpt.js does the same for the JLPT lists.
//
// Item: { key: 'w:<text>|<reading>', text, reading, answers, altAnswers, gloss, split, level, zipf,
//         tags: ['kb:step7', ...], order, src }
// `src` is the bundle entry, kept in memory for the furigana and the kanji hover cards; it is
// never saved. Progress records only ever hold the key and stats.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SrsContentKB = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const toHira = s => String(s).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
    const hasKanji = s => /[㐀-䶿一-鿿豈-﫿々]/.test(s);
    const keyOf = (text, reading) => 'w:' + text + '|' + reading;

    // words: entries from KB1Core.selectWords (any order). -> { items, dropped }
    // dropped: words whose text has no kanji (the prompt would be the answer).
    function itemsFromWords(words) {
        const indexed = (words || []).map((w, i) => ({ w, i }));
        const kept = [], dropped = [];
        for (const x of indexed) (hasKanji(x.w.base.kanji) ? kept : dropped).push(x);
        kept.sort((a, b) => (a.w.kb1.steps[0] - b.w.kb1.steps[0]) ||
                            ((b.w.kb1.in_class ? 1 : 0) - (a.w.kb1.in_class ? 1 : 0)) || (a.i - b.i));
        // Same spelling, other reading (homographs): every reading in the group is accepted.
        const byText = new Map();
        for (const { w } of kept) {
            if (!byText.has(w.base.kanji)) byText.set(w.base.kanji, []);
            byText.get(w.base.kanji).push(toHira(w.base.kana));
        }
        const items = kept.map(({ w }, order) => {
            const main = toHira(w.base.kana);
            const alt = new Set([...((w.kb1 && w.kb1.alt_readings) || []).map(toHira), ...byText.get(w.base.kanji)]);
            alt.delete(main);
            return {
                key: keyOf(w.base.kanji, w.base.kana),
                text: w.base.kanji,
                reading: w.base.kana,
                answers: [main],
                altAnswers: Array.from(alt),
                gloss: w.meaning || '',
                split: (w.kb1 && w.kb1.split) || null,
                level: null, zipf: null,
                tags: (w.kb1.steps || []).map(s => 'kb:step' + s),
                order,
                src: w,
            };
        });
        return { items, dropped: dropped.map(x => x.w.id) };
    }

    return { itemsFromWords, keyOf, hasKanji };
}));
