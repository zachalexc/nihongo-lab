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

    const NEW_MODES = ['kb1-reading-typed', 'kb1-reading-mc', 'kb1-meaning-mc', 'kb1-kanji',
                       'kb1-which-typed', 'kb1-which-mc', 'kb1-special-typed', 'kb1-special-mc', 'kb1-exam'];
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

    // ---- kanji readings (訓読み / 音読み): only the readings taught in class ---------------
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

    // Kun'yomi first everywhere, each with a reminder of what it is
    const KIND_NAME = { on: "on'yomi", kun: "kun'yomi" };
    const KIND_JA = { on: '音読み', kun: '訓読み' };
    const KIND_HINT = { on: 'Chinese reading', kun: 'Japanese reading' };
    const KIND_FULL = { on: "on'yomi 音 (Chinese reading)", kun: "kun'yomi 訓 (Japanese reading)" };

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
            promptText: kanjiPrompt(k, `Write the ${KIND_NAME[kind]} (${KIND_JA[kind]} · ${KIND_HINT[kind]})${how}` +
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
            promptText: kanjiPrompt(k, `${line} (${KIND_JA[kind]} · ${KIND_HINT[kind]})`),
            choices: shuffle([correct, ...wrong], rng),
            choicesLang: 'ja',
            correctAnswer: correct,
            correctAnswerKana: correct,
        });
    }

    const ON_KUN_CHOICES = ["kun'yomi 訓 (Japanese)", "on'yomi 音 (Chinese)"];   // kun first: key 1 = kun
    function kanjiOnOrKun(k, rng) {
        const options = [...taught(k, 'on').map(e => ['on', e.label]), ...taught(k, 'kun').map(e => ['kun', e.label])];
        const [kind, label] = options[Math.floor(rng() * options.length)];
        return Object.assign(kanjiBase(k, 'kanji-onkun'), {
            kind, asked: label,
            promptText: kanjiPrompt(k, `Is <span class="kb1-inline" lang="ja">${escapeHtml(label)}</span> a kun'yomi (Japanese) or an on'yomi (Chinese) reading of this kanji?`),
            choices: [...ON_KUN_CHOICES],
            choicesFixedOrder: true,
            correctAnswer: kind === 'kun' ? ON_KUN_CHOICES[0] : ON_KUN_CHOICES[1],
            correctAnswerKana: label,
        });
    }

    const KANJI_TYPES = ['kun-typed', 'on-typed', 'kun-mc', 'on-mc', 'onkun'];

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
        const ex = (k.kb1.examples || []).map(([w, r, , , inClass]) =>
            `${escapeHtml(w)}<span class="kb1-ex-r">（${escapeHtml(r)}）</span>` +
            (inClass === false ? '<span class="kb1-extra-tag">extra</span>' : '')).join('、');
        return `<div class="kb1-info" lang="ja"><b>${escapeHtml(k.base.kanji)}</b>　訓 <span class="kb1-kind">kun (Japanese)</span>: ${escapeHtml(kun)}` +
            `　／　音 <span class="kb1-kind">on (Chinese)</span>: ${escapeHtml(on)}` +
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

    // ---- which reading is used: one kanji highlighted in a class word ---------------------
    // Uses the word's per-kanji reading split; parts marked 'special' (熟字訓) are never asked.
    function whichItems(words, kanjiByChar) {
        const items = [];
        for (const w of words) {
            const parts = w.kb1.split || [];
            if (w.base.kanji.length === 1) continue;     // "上 in 上" asks nothing new
            parts.forEach((part, i) => {
                const [text, reading, type] = part;
                if ((type === 'on' || type === 'kun') && text.length === 1 && kanjiByChar.has(text)) {
                    items.push({ word: w, index: i });
                }
            });
        }
        return items;
    }

    function highlightPart(w, index) {
        return w.kb1.split.map(([t], i) => i === index ? `<span class="kb1-hl">${escapeHtml(t)}</span>` : escapeHtml(t)).join('');
    }

    function whichQuestion(item, kanjiByChar, mc, rng) {
        const w = item.word, [ch, reading, type] = w.kb1.split[item.index];
        const k = kanjiByChar.get(ch);
        // what follows the kanji in kana (okurigana): いきる is accepted for 生 in 生きる
        let tail = '';
        for (let j = item.index + 1; j < w.kb1.split.length && w.kb1.split[j][2] === 'kana'; j++) tail += w.kb1.split[j][1];
        const q = {
            kb1: true, qtype: mc ? 'which-mc' : 'which-typed', wordId: `${w.id}:${item.index}`, sourceWordId: w.id,
            kanjiId: k.id, formKey: 'base', step: 0, kanjiText: '', readText: w.base.kana,
            revealText: w.base.kanji, revealMeaning: w.meaning, correctAnswerRomaji: '___NO_ROMAJI___',
            correctAnswerKana: reading, partType: type, askedKanji: ch, steps: w.kb1.steps,
            acceptAnswers: tail ? [reading + tail] : [],
            promptText: `<div class="kb1-word" lang="ja">${highlightPart(w, item.index)}</div>` +
                `<div class="kb1-instruction">How is <span class="kb1-inline" lang="ja">${escapeHtml(ch)}</span> read in this word?` +
                (mc ? '' : ' Type it in hiragana') + '</div>',
        };
        if (mc) {
            // one spelling per reading, as it appears inside words (kun: the stem, not the dictionary form)
            const all = [...k.kb1.on_readings.flatMap(([m, v]) => [m, ...v]),
                         ...k.kb1.kun_readings.flatMap(r => [r.stem, ...r.variants])];
            // then near-miss sounds, then readings of other kanji from the same Step
            const sameStep = shuffle([...kanjiByChar.values()].filter(o => o !== k && o.kb1.steps[0] === k.kb1.steps[0]), rng)
                .flatMap(o => taught(o, type).map(e => stripParens(e.forms[0])));
            const pool = [...shuffle(all, rng), ...nearMisses(reading), ...sameStep];
            const wrong = [];
            for (const c of pool) {
                if (wrong.length >= 3) break;
                if (c && c !== reading && !wrong.includes(c) && c !== reading + tail) wrong.push(c);
            }
            q.choices = shuffle([reading, ...wrong], rng);
            q.choicesLang = 'ja';
            q.correctAnswer = reading;
        }
        return q;
    }

    // ---- ※ special readings (熟字訓 and irregular words) ---------------------------------
    function specialWords(data, opts) {
        const steps = new Set(opts.steps);
        return data.vocabulary.filter(w => w.type !== 'kanji' && w.kb1.special &&
            w.kb1.steps.some(s => steps.has(s)) && !(opts.exclude && opts.exclude.has(w.id)));
    }

    function specialQuestion(w, mc, rng) {
        const extraTag = w.kb1.in_class ? '' : ' <span class="kb1-extra-tag">extra</span>';
        if (!mc) {
            const q = readingTyped(w);
            q.qtype = 'special-typed';
            q.promptText = q.promptText.replace('</div><div class="kb1-instruction">', `${extraTag}</div><div class="kb1-instruction">※ special reading — `);
            return q;
        }
        const regular = (w.kb1.d_regular || []).filter(x => x !== w.base.kana);
        const others = (w.kb1.d_reading || []).filter(x => x !== w.base.kana && !regular.includes(x));
        const wrong = [...shuffle(regular, rng).slice(0, 2), ...shuffle(others, rng)].slice(0, 3);
        return Object.assign(base(w, 'special-mc'), {
            promptText: wordPrompt(w, '※ special reading — choose the reading').replace('</div><div', `${extraTag}</div><div`),
            choices: shuffle([w.base.kana, ...wrong], rng), choicesLang: 'ja', correctAnswer: w.base.kana,
        });
    }

    // ---- mock exam ------------------------------------------------------------------
    const EXAM_TYPES = {
        'w-typed':  "Word → reading (type)",
        'w-mc':     "Word → reading (choose)",
        'w-meaning':"Word → meaning",
        'k-typed':  "Kun'yomi / on'yomi (type)",
        'k-mc':     "Kun'yomi / on'yomi (choose)",
        'k-onkun':  "Kun'yomi or on'yomi?",
        'which':    "Which reading is used",
        'special':  "※ Special readings",
    };

    // Questions spread over the chosen Steps in proportion to their handout words; the type of
    // each question is picked at random from the chosen types that have something left to ask.
    function buildExam(src, opts, rng = Math.random) {
        const count = Math.max(1, opts.examCount || 50);
        const types = (opts.examTypes && opts.examTypes.length) ? opts.examTypes : Object.keys(EXAM_TYPES);
        const kanjiByChar = new Map((src.kanjiAll || []).map(k => [k.base.kanji, k]));
        const stepOf = x => x.kb1.steps[0];
        const share = {};
        for (const w of src.words) if (w.kb1.in_class) share[stepOf(w)] = (share[stepOf(w)] || 0) + 1;
        const steps = opts.steps.filter(st => share[st]);
        const total = steps.reduce((a, st) => a + share[st], 0);
        // largest-remainder allocation of `count` over the Steps
        const exact = steps.map(st => count * share[st] / total);
        const alloc = exact.map(Math.floor);
        let left = count - alloc.reduce((a, b) => a + b, 0);
        exact.map((x, i) => [x - alloc[i], i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => alloc[i]++);

        const out = [];
        steps.forEach((st, si) => {
            const pools = {
                'w-typed': shuffle(src.words.filter(w => stepOf(w) === st), rng),
                'w-mc': shuffle(src.words.filter(w => stepOf(w) === st), rng),
                'w-meaning': shuffle(src.words.filter(w => stepOf(w) === st), rng),
                'k-typed': shuffle((src.kanji || []).filter(k => stepOf(k) === st).flatMap(k => [[k, 'kun'], [k, 'on']]), rng),
                'k-mc': shuffle((src.kanji || []).filter(k => stepOf(k) === st).flatMap(k => [[k, 'kun'], [k, 'on']]), rng),
                'k-onkun': shuffle((src.kanji || []).filter(k => stepOf(k) === st), rng),
                'which': shuffle(whichItems(src.words.filter(w => stepOf(w) === st), kanjiByChar), rng),
                'special': shuffle((src.special || []).filter(w => stepOf(w) === st && (w.kb1.in_class || opts.includeExtra)), rng),
            };
            const usedWords = new Set();
            for (let n = 0; n < alloc[si]; n++) {
                const open = types.filter(t => pools[t] && pools[t].length);
                if (!open.length) break;
                const t = open[Math.floor(rng() * open.length)];
                let q = null;
                while (pools[t].length && !q) {
                    const it = pools[t].pop();
                    const key = t.startsWith('k-') ? (Array.isArray(it) ? it[0].id + it[1] : it.id) + t
                        : t === 'which' ? it.word.id : it.id;
                    if (usedWords.has(key)) continue;
                    usedWords.add(key);
                    if (t === 'w-typed') q = readingTyped(it);
                    else if (t === 'w-mc') q = readingChoice(it, rng);
                    else if (t === 'w-meaning') q = meaningChoice(it, rng);
                    else if (t === 'k-typed') q = kanjiTyped(it[0], it[1]);
                    else if (t === 'k-mc') q = kanjiChoice(it[0], it[1], src.kanji, rng);
                    else if (t === 'k-onkun') q = kanjiOnOrKun(it, rng);
                    else if (t === 'which') q = whichQuestion(it, kanjiByChar, rng() < 0.5, rng);
                    else if (t === 'special') q = specialQuestion(it, rng() < 0.5, rng);
                }
                if (q) { q.examType = t; q.examStep = st; out.push(q); }
            }
        });
        return shuffle(out, rng);
    }

    // Results: overall, by Step, by type, and every miss.
    function examResultsHtml(records, lookupKanji) {
        const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
        const right = records.filter(r => r.correct).length;
        const group = key => {
            const m = new Map();
            for (const r of records) {
                const k = key(r); const g = m.get(k) || [0, 0];
                g[0] += r.correct ? 1 : 0; g[1]++; m.set(k, g);
            }
            return [...m.entries()];
        };
        const row = (label, [a, b]) => `<tr><td>${label}</td><td>${a} / ${b}</td><td>${pct(a, b)}%</td></tr>`;
        const bySteps = group(r => r.q.examStep).sort((a, b) => a[0] - b[0]).map(([k, g]) => row(`Step ${k}`, g)).join('');
        const byTypes = group(r => r.q.examType).map(([k, g]) => row(escapeHtml(EXAM_TYPES[k] || k), g)).join('');
        const misses = records.filter(r => !r.correct).map(r => {
            const q = r.q;
            const isKanji = q.qtype.startsWith('kanji-');
            const k = isKanji && lookupKanji ? lookupKanji(q.kanjiId) : null;
            const what = q.qtype.startsWith('which') ? `${escapeHtml(q.askedKanji)} in ${escapeHtml(q.revealText)}` : escapeHtml(q.revealText);
            const correct = q.qtype === 'kanji-onkun' ? `${escapeHtml(q.asked)} = ${escapeHtml(KIND_FULL[q.kind])}` : escapeHtml(q.correctAnswer || q.correctAnswerKana);
            const detail = k ? `訓 kun (Japanese): ${escapeHtml(taught(k, 'kun').map(e => e.label).join('・') || 'なし')} ／ 音 on (Chinese): ${escapeHtml(taught(k, 'on').map(e => e.label).join('・'))}`
                : `${escapeHtml(q.readText || '')} · ${escapeHtml(q.revealMeaning || '')}`;
            return `<tr><td lang="ja">${what}</td><td>${escapeHtml(EXAM_TYPES[q.examType] || '')}</td>` +
                `<td lang="ja">${r.answer == null || r.answer === '' ? '<i>skipped</i>' : escapeHtml(r.answer)}</td>` +
                `<td lang="ja">${correct}</td><td lang="ja">${detail}</td></tr>`;
        }).join('');
        return `<div class="kb1-results">
            <div class="kb1-score">${right} / ${records.length} <span>(${pct(right, records.length)}%)</span></div>
            <div class="kb1-results-tables">
              <table><thead><tr><th>Step</th><th>Score</th><th></th></tr></thead><tbody>${bySteps}</tbody></table>
              <table><thead><tr><th>Question type</th><th>Score</th><th></th></tr></thead><tbody>${byTypes}</tbody></table>
            </div>
            ${misses ? `<h4>Misses</h4><div class="kb1-misses"><table><thead><tr><th>Question</th><th>Type</th><th>Your answer</th><th>Correct</th><th>Reading · meaning</th></tr></thead><tbody>${misses}</tbody></table></div>` : '<p>No misses — well done!</p>'}
        </div>`;
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
                    ? `${escapeHtml(q.asked)} is ${q.kind === 'on' ? 'an' : 'a'} ${escapeHtml(KIND_FULL[q.kind])}`
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

        // which reading: typed or chosen; feedback = the word + the kanji's taught readings
        if (q.qtype && q.qtype.startsWith('which-')) {
            const c = given !== null && (q.choices ? given === q.correctAnswer
                : (toHira(given) === q.correctAnswerKana || (q.acceptAnswers || []).includes(toHira(given))));
            const k = lookupKanji ? lookupKanji(q.kanjiId) : null;
            return ok(c, `<div class="kb1-answer">${mark(c)} <span lang="ja">${escapeHtml(q.correctAnswerKana)}</span> ` +
                `(${escapeHtml(KIND_FULL[q.partType])}) — <span lang="ja">${escapeHtml(q.revealText)}</span> = ` +
                `<span lang="ja">${escapeHtml(q.readText)}</span> · ${escapeHtml(q.revealMeaning)}</div>` + (k ? kanjiInfoHtml(k) : ''));
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
        if (mode === 'kb1-which-typed' || mode === 'kb1-which-mc') {
            const byChar = new Map((src.kanjiAll || []).map(k => [k.base.kanji, k]));
            return whichItems(words, byChar).map(it => whichQuestion(it, byChar, mode === 'kb1-which-mc', rng));
        }
        if (mode === 'kb1-special-typed') return (src.special || []).map(w => specialQuestion(w, false, rng));
        if (mode === 'kb1-special-mc') return (src.special || []).map(w => specialQuestion(w, true, rng));
        if (mode === 'kb1-exam') return buildExam(src, opts, rng);
        return [];
    }

    // Number of cards a session would have.
    function estimate(data, opts, mode) {
        if (!opts.steps.length) return 0;
        if (SENTENCE_MODES.includes(mode)) return selectSentences(data, opts).length;
        if (mode === 'kb1-kanji') return selectKanji(data, opts).length * (opts.kanjiTypes || KANJI_TYPES).length;
        if (mode === 'kb1-which-typed' || mode === 'kb1-which-mc') {
            const byChar = new Map(data.vocabulary.filter(k => k.type === 'kanji').map(k => [k.base.kanji, k]));
            return whichItems(selectWords(data, opts), byChar).length;
        }
        if (mode === 'kb1-special-typed' || mode === 'kb1-special-mc') return specialWords(data, opts).length;
        if (mode === 'kb1-exam') return opts.examCount || 50;
        return selectWords(data, opts).length;
    }

    function checkTyped(q, input) { return grade(q, input).correct; }

    return { NEW_MODES, SENTENCE_MODES, KANJI_TYPES, NONE_LABEL, shuffle, escapeHtml, hasKatakana,
             selectWords, selectSentences, selectKanji, readingTyped, readingChoice, meaningChoice,
             kanjiTyped, kanjiChoice, kanjiOnOrKun, kanjiQuestions, kanjiInfoHtml, taught,
             whichItems, whichQuestion, specialWords, specialQuestion, EXAM_TYPES, buildExam, examResultsHtml,
             grade, buildQueue, estimate, checkTyped };
});
