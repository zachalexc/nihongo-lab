// Kanji Basic 1 (漢字基礎１) — selection and the class-only question types.
//
// The class data uses the app's own formats: `vocabulary` entries are data.json words
// (id, type, subType, meaning, base{kana, romaji, kanji}) and `sentences` are sentence_data.json
// sentences. Class-only information sits in an optional `kb1` field on each entry
// (steps, in_class/extra/special flags, on/kun, reading split, multiple-choice distractors).
//
// Modes that already exist in the app (translation, verb group, sentence reading, flash,
// listening) are built by app.js's shared builders from selectWords()/selectSentences().
// This file only builds what the app didn't have: reading from kanji (typed), multiple choice,
// and the kanji reading (音/訓) questions — plus one grade() used for every class question.
// Pure functions (no DOM), so they also run in Node tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.KB1Core = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const NEW_MODES = ['kb1-reading-typed', 'kb1-reading-mc', 'kb1-meaning-mc', 'kb1-kanji'];
    const SENTENCE_MODES = ['reading'];

    function shuffle(array, rng = Math.random) {
        const a = [...array];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const hasKatakana = s => /[ァ-ヶ]/.test(s);

    // ---- selection ------------------------------------------------------------------
    // opts: { steps: [1..6], includeExtra: bool, exclude: Set of learned word ids (optional) }

    function selectWords(data, opts) {
        const steps = new Set(opts.steps);
        const exclude = opts.exclude || new Set();
        return data.vocabulary.filter(w =>
            w.type !== 'kanji' &&
            (w.kb1.in_class || (opts.includeExtra && w.kb1.extra)) &&
            w.kb1.steps.some(s => steps.has(s)) &&
            !exclude.has(w.id));
    }

    function selectKanji(data, opts) {
        const steps = new Set(opts.steps);
        return data.vocabulary.filter(k => k.type === 'kanji' && k.kb1.steps.some(s => steps.has(s)));
    }

    // A sentence is in range when it practises a word from a selected Step and uses
    // no course kanji beyond the highest selected Step.
    function selectSentences(data, opts) {
        const steps = new Set(opts.steps);
        const maxStep = Math.max(0, ...opts.steps);
        return data.sentences.filter(s =>
            s.kb1.steps.some(st => steps.has(st)) && s.kb1.kanji_max_step <= maxStep);
    }

    // ---- class-only questions (they read the same data.json-format entries) ----------
    function wordPrompt(w, instruction) {
        return `<div class="kb1-word" lang="ja">${escapeHtml(w.base.kanji)}</div>` +
               `<div class="kb1-instruction">${instruction}</div>`;
    }

    function base(w, qtype) {
        return {
            kb1: true, qtype, wordId: w.id, formKey: 'base', step: 0,
            readText: w.base.kana,        // for speech
            kanjiText: '',                // the prompt shows the kanji: don't accept kanji as an answer
            revealText: w.base.kanji,     // shown with the answer after a miss
            revealMeaning: w.meaning,
            correctAnswerKana: w.base.kana,
            correctAnswerRomaji: '___NO_ROMAJI___',
        };
    }

    function readingTyped(w) {
        return Object.assign(base(w, 'reading-typed'), {
            promptText: wordPrompt(w, hasKatakana(w.base.kana)
                ? 'Type the reading — hiragana, with katakana parts in katakana (Caps Lock)'
                : 'Type the reading in hiragana'),
            acceptAnswers: [],            // katakana must be typed as katakana: no folding
        });
    }

    function pickChoices(correct, pool, rng, n = 4) {
        const wrong = shuffle(pool.filter(x => x !== correct), rng).slice(0, n - 1);
        return shuffle([correct, ...wrong], rng);
    }

    function readingChoice(w, rng) {
        return Object.assign(base(w, 'reading-mc'), {
            promptText: wordPrompt(w, 'Choose the reading'),
            choices: pickChoices(w.base.kana, w.kb1.d_reading, rng),
            choicesLang: 'ja',
            correctAnswer: w.base.kana,
        });
    }

    function meaningChoice(w, rng) {
        return Object.assign(base(w, 'meaning-mc'), {
            promptText: wordPrompt(w, 'Choose the meaning'),
            choices: pickChoices(w.meaning, w.kb1.d_meaning, rng),
            choicesLang: 'en',
            correctAnswer: w.meaning,
        });
    }

    // ---- kanji readings (音読み / 訓読み): only the readings taught in class ---------------
    const KANA_SEP = /[\s・、,，\/／]+/;
    const NONE_LABEL = 'none (なし)';
    const NONE_INPUTS = new Set(['なし', 'none', 'ない', 'ナシ']);
    const toHira = s => String(s).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
    const stripParens = s => s.replace(/[()（）]/g, '');

    // Taught readings of one type: [{label, forms}] — label as written on the handout,
    // forms = every accepted spelling (sound-change variants; kun with or without okurigana).
    function taught(k, kind) {
        if (kind === 'on') return k.kb1.on_readings.map(([main, variants]) => ({ label: main, forms: [main, ...variants] }));
        return k.kb1.kun_readings.map(r => ({ label: r.text, forms: [r.kana, r.stem, ...r.variants] }));
    }

    const KIND_NAME = { on: "on'yomi", kun: "kun'yomi" };
    const KIND_JA = { on: '音読み', kun: '訓読み' };

    function kanjiPrompt(k, line) {
        return `<div class="kb1-word" lang="ja">${escapeHtml(k.base.kanji)}</div><div class="kb1-instruction">${line}</div>`;
    }

    function kanjiBase(k, qtype) {
        return {
            kb1: true, qtype, wordId: `${k.id}:${qtype}`, kanjiId: k.id, formKey: 'base', step: 0,
            kanjiText: '', readText: '', revealText: k.base.kanji, revealMeaning: k.meaning,
            correctAnswerRomaji: '___NO_ROMAJI___',
        };
    }

    function kanjiTyped(k, kind) {
        const expected = taught(k, kind);
        const n = expected.length;
        const how = n > 1 ? ` — ${n} ${KIND_NAME[kind]}, separated by a space or ・` : '';
        return Object.assign(kanjiBase(k, `kanji-${kind}-typed`), {
            kind, expected,
            allowNone: kind === 'kun',      // always offered for kun, so it gives nothing away
            promptText: kanjiPrompt(k, `Write the ${KIND_NAME[kind]} (${KIND_JA[kind]})${how}` +
                (kind === 'kun' ? ' — okurigana optional' : '') + (kind === 'on' ? ' in hiragana' : '')),
            correctAnswerKana: n ? expected.map(e => e.label).join('・') : 'なし',
            readText: n ? expected[0].forms[0] : '',
        });
    }

    // Small sound changes for wrong options: voicing, long vowel, small っ
    const DAKU = { か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご', さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ', た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど', は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ' };
    const UNDAKU = Object.fromEntries(Object.entries(DAKU).map(([a, b]) => [b, a]));
    function nearMisses(r) {
        const out = new Set();
        const head = r[0], rest = r.slice(1), core = stripParens(r);
        if (DAKU[head]) out.add(DAKU[head] + rest);
        if (UNDAKU[head]) out.add(UNDAKU[head] + rest);
        if (/[うい]$/.test(core) && core.length > 1 && !/[()（）]/.test(r)) out.add(r.slice(0, -1));
        else if (/[こそとのほもよょろごぞどぼ]$/.test(r)) out.add(r + 'う');
        if (/[くつち]$/.test(r)) out.add(r.slice(0, -1) + 'っ');
        out.delete(r);
        return [...out];
    }

    function kanjiChoice(k, kind, all, rng) {
        const mine = taught(k, kind);
        const other = taught(k, kind === 'on' ? 'kun' : 'on');
        const mineForms = new Set(mine.flatMap(e => e.forms.map(stripParens)));
        let correct, line;
        if (mine.length) {
            correct = mine[Math.floor(rng() * mine.length)].label;
            line = mine.length > 1 ? `Choose one of its ${KIND_NAME[kind]}` : `Choose its ${KIND_NAME[kind]}`;
        } else {
            correct = NONE_LABEL;
            line = `Choose its ${KIND_NAME[kind]}`;
        }
        const sameStep = all.filter(o => o.id !== k.id && o.kb1.steps[0] === k.kb1.steps[0]);
        const pool = [
            ...other.map(e => e.label),                                        // the other reading type: the classic trap
            ...(mine.length ? nearMisses(correct) : []),
            ...shuffle(sameStep, rng).flatMap(o => taught(o, kind).map(e => e.label)),
            ...(kind === 'kun' && mine.length ? [NONE_LABEL] : []),
        ];
        const seen = new Set([correct]);
        const wrong = [];
        for (const cand of pool) {
            if (wrong.length >= 3) break;
            if (seen.has(cand) || (cand !== NONE_LABEL && mineForms.has(stripParens(cand)))) continue;
            seen.add(cand); wrong.push(cand);
        }
        // keep the other-type trap, shuffle the rest in
        return Object.assign(kanjiBase(k, `kanji-${kind}-mc`), {
            kind,
            promptText: kanjiPrompt(k, `${line} (${KIND_JA[kind]})`),
            choices: shuffle([correct, ...wrong], rng),
            choicesLang: 'ja',
            correctAnswer: correct,
            correctAnswerKana: correct,
        });
    }

    const ON_KUN_CHOICES = ["on'yomi (音)", "kun'yomi (訓)"];
    function kanjiOnOrKun(k, rng) {
        const options = [...taught(k, 'on').map(e => ['on', e.label]), ...taught(k, 'kun').map(e => ['kun', e.label])];
        const [kind, label] = options[Math.floor(rng() * options.length)];
        return Object.assign(kanjiBase(k, 'kanji-onkun'), {
            kind, asked: label,
            promptText: kanjiPrompt(k, `Is <span class="kb1-inline" lang="ja">${escapeHtml(label)}</span> an on'yomi or a kun'yomi of this kanji?`),
            choices: [...ON_KUN_CHOICES],
            choicesFixedOrder: true,
            correctAnswer: kind === 'on' ? ON_KUN_CHOICES[0] : ON_KUN_CHOICES[1],
            correctAnswerKana: label,
        });
    }

    const KANJI_TYPES = ['on-typed', 'kun-typed', 'on-mc', 'kun-mc', 'onkun'];

    function kanjiQuestions(kanjiList, types, rng = Math.random) {
        const out = [];
        for (const k of kanjiList) {
            for (const t of types) {
                if (t === 'on-typed') out.push(kanjiTyped(k, 'on'));
                if (t === 'kun-typed') out.push(kanjiTyped(k, 'kun'));
                if (t === 'on-mc') out.push(kanjiChoice(k, 'on', kanjiList, rng));
                if (t === 'kun-mc') out.push(kanjiChoice(k, 'kun', kanjiList, rng));
                if (t === 'onkun') out.push(kanjiOnOrKun(k, rng));
            }
        }
        return out;
    }

    // Everything taught for a kanji, shown after each answer.
    function kanjiInfoHtml(k) {
        const kun = taught(k, 'kun').map(e => e.label).join('・') || 'なし';
        const on = taught(k, 'on').map(e => e.label).join('・');
        const sp = (k.kb1.special_readings || []).map(x => `${x.reading}（${x.words.join('、')}）`).join('・');
        const ex = (k.kb1.examples || []).map(([w, r]) => `${escapeHtml(w)}<span class="kb1-ex-r">（${escapeHtml(r)}）</span>`).join('、');
        return `<div class="kb1-info" lang="ja"><b>${escapeHtml(k.base.kanji)}</b>　訓: ${escapeHtml(kun)}　／　音: ${escapeHtml(on)}` +
            (sp ? `　／　特別: ${escapeHtml(sp)}` : '') + `<br><span class="kb1-ex">${ex}</span>` +
            `<span class="kb1-meaning"> · ${escapeHtml(k.meaning)}</span></div>`;
    }

    // Match typed readings to the expected ones (any order). Returns per-expected hits and stray tokens.
    function matchReadings(tokens, expected) {
        const norm = t => stripParens(toHira(t));
        const used = new Array(expected.length).fill(false);
        const stray = [];
        for (const t of tokens) {
            const i = expected.findIndex((e, j) => !used[j] && e.forms.some(f => stripParens(f) === norm(t)));
            if (i >= 0) used[i] = true; else stray.push(t);
        }
        return { used, stray };
    }

    // ---- grading: one function for every class question -----------------------------
    // Returns { correct, html } — html is the feedback shown until the user presses Next.
    function grade(q, input, lookupKanji) {
        const given = input == null ? null : String(input).trim();
        const ok = (c, html) => ({ correct: c, html });
        const mark = c => c ? '<span class="kb1-ok">✓</span>' : '<span class="kb1-ng">✗</span>';

        if (q.qtype && q.qtype.startsWith('kanji-')) {
            const k = lookupKanji ? lookupKanji(q.kanjiId) : null;
            const info = k ? kanjiInfoHtml(k) : '';
            if (q.choices) {
                const c = given === q.correctAnswer;
                const line = q.qtype === 'kanji-onkun'
                    ? `${escapeHtml(q.asked)} is ${q.kind === 'on' ? "an on'yomi (音)" : "a kun'yomi (訓)"}`
                    : `Answer: ${escapeHtml(q.correctAnswer)}`;
                return ok(c, `<div class="kb1-answer">${mark(c)} ${line}</div>${info}`);
            }
            // typed
            const exp = q.expected;
            if (given === null) return ok(false, `<div class="kb1-answer">${mark(false)} ${escapeHtml(q.correctAnswerKana)}</div>${info}`);
            const tokens = given.replace(/[()（）]/g, m => m === '（' ? '(' : m === '）' ? ')' : m).split(KANA_SEP).filter(Boolean);
            if (!exp.length) {
                const c = tokens.length > 0 && tokens.every(t => NONE_INPUTS.has(t.toLowerCase()));
                return ok(c, `<div class="kb1-answer">${mark(c)} No ${KIND_NAME[q.kind]} was taught for this kanji (なし)</div>${info}`);
            }
            if (tokens.some(t => NONE_INPUTS.has(t.toLowerCase()))) {
                return ok(false, `<div class="kb1-answer">${mark(false)} ${escapeHtml(q.correctAnswerKana)}</div>${info}`);
            }
            const { used, stray } = matchReadings(tokens, exp);
            const c = used.every(Boolean) && stray.length === 0;
            const parts = exp.map((e, i) => `${mark(used[i])} ${escapeHtml(e.label)}`).join('　');
            const extra = stray.length ? `　${mark(false)} <s>${escapeHtml(stray.join('・'))}</s>` : '';
            return ok(c, `<div class="kb1-answer">${parts}${extra}</div>${info}`);
        }

        // words: choices, or typed reading / meaning -> word
        let c;
        if (given === null) c = false;
        else if (q.choices) c = given === q.correctAnswer;
        else {
            const low = given.toLowerCase();
            c = given === q.correctAnswerKana || (q.acceptAnswers || []).includes(given) ||
                (q.correctAnswerRomaji && low === q.correctAnswerRomaji.toLowerCase()) ||
                (!!q.kanjiText && given === q.kanjiText);
        }
        const word = q.revealText || q.kanjiText || '';
        const html = `<div class="kb1-answer">${mark(c)} <span lang="ja">${escapeHtml(word)}</span>` +
            (word ? ' = ' : '') + `<span lang="ja">${escapeHtml(q.correctAnswerKana)}</span>` +
            (q.revealMeaning ? ` · ${escapeHtml(q.revealMeaning)}` : '') + '</div>';
        return ok(c, html);
    }

    // Questions for the class-only modes, from the same entries.
    // src: { words, kanji } from selectWords()/selectKanji(); opts.kanjiTypes for the kanji mode.
    function buildQueue(src, mode, opts = {}, rng = Math.random) {
        const words = src.words || [];
        if (mode === 'kb1-reading-typed') return words.map(readingTyped);
        if (mode === 'kb1-reading-mc') return words.map(w => readingChoice(w, rng));
        if (mode === 'kb1-meaning-mc') return words.map(w => meaningChoice(w, rng));
        if (mode === 'kb1-kanji') return kanjiQuestions(src.kanji || [], opts.kanjiTypes || KANJI_TYPES, rng);
        return [];
    }

    // Number of cards a session would have.
    function estimate(data, opts, mode) {
        if (!opts.steps.length) return 0;
        if (SENTENCE_MODES.includes(mode)) return selectSentences(data, opts).length;
        if (mode === 'kb1-kanji') return selectKanji(data, opts).length * (opts.kanjiTypes || KANJI_TYPES).length;
        return selectWords(data, opts).length;
    }

    function checkTyped(q, input) { return grade(q, input).correct; }

    return { NEW_MODES, SENTENCE_MODES, KANJI_TYPES, NONE_LABEL, shuffle, escapeHtml, hasKatakana,
             selectWords, selectSentences, selectKanji, readingTyped, readingChoice, meaningChoice,
             kanjiTyped, kanjiChoice, kanjiOnOrKun, kanjiQuestions, kanjiInfoHtml, taught,
             grade, buildQueue, estimate, checkTyped };
});
