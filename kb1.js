// Kanji Basic 1 (漢字基礎１) tab: unlocking, settings and the class data source.
// The class data is in the app's own formats (data.json words, sentence_data.json sentences)
// with an optional `kb1` field on each entry. app.js builds sessions from it with the same
// builders the other tabs use; kb1_core.js adds the class-only question types.
// The data is decrypted in memory only and is gone on page reload (as on the Dev tab).
window.KB1 = (function () {
    'use strict';

    const ENC_FILE = 'kb1.enc';
    let ctx = null;      // from app.js: decryptEncFile, flashElementColor, updateLiveEstimator, renderMasterList, isKnown, knownIds
    let data = null;     // { meta, vocabulary: [...data.json entries], sentences: [...sentence_data.json entries] }
    let byId = new Map();

    const $ = id => document.getElementById(id);

    function init(context) {
        ctx = context;
        const btn = $('kb1-unlock-btn'), input = $('kb1-password-input');
        if (!btn || !input) return;
        btn.addEventListener('click', () => unlock(input.value));
        document.addEventListener('change', e => { if (e.target.name === 'kb1-mode') showModeOptions(); });
        ['kb1-exam-count', 'kb1-exam-minutes'].forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('input', () => { ctx.saveSettings(); ctx.updateLiveEstimator(); });
        });
        showModeOptions();
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); unlock(input.value); }
        });
    }

    async function unlock(password) {
        const input = $('kb1-password-input'), err = $('kb1-error-msg'), btn = $('kb1-unlock-btn');
        if (!password) {
            ctx.flashElementColor(input, 'var(--error-color)');
            err.textContent = 'Please enter a password';
            return;
        }
        err.textContent = '';
        btn.disabled = true; btn.textContent = 'Unlocking...';
        try {
            const bundle = await ctx.decryptEncFile(ENC_FILE, password);
            if (!bundle || !bundle.meta || !Array.isArray(bundle.vocabulary) || !Array.isArray(bundle.sentences)) {
                throw new Error('Unexpected data');
            }
            data = bundle;
            byId = new Map(data.vocabulary.map(w => [w.id, w]));
            renderInfo();
            renderLearnedList();
            $('kb1-lock-view').classList.add('hidden');
            $('kb1-settings-view').classList.remove('hidden');
            input.value = '';
            ctx.updateLiveEstimator();
        } catch (e) {
            console.warn('KB1 unlock failed:', e);
            ctx.flashElementColor(input, 'var(--error-color)');
            input.focus();
            err.textContent = 'Incorrect password';
        } finally {
            btn.disabled = false; btn.textContent = 'Unlock';
        }
    }

    // Extra options for the chosen mode (the kanji question types)
    function showModeOptions() {
        const box = $('kb1-kanji-options');
        if (box) box.classList.toggle('hidden', mode() !== 'kb1-kanji');
        const exam = $('kb1-exam-options');
        if (exam) exam.classList.toggle('hidden', mode() !== 'kb1-exam');
    }

    function renderInfo() {
        const c = data.meta.counts, el = $('kb1-data-info');
        if (el) el.textContent =
            `${c.class_words} handout words · ${c.kanji} kanji · ${c.sentences} sentences · data ${data.meta.export_generated}`;
    }

    // The app's own "learned" list (check to exclude), for the class words.
    function renderLearnedList() {
        const container = $('master-list-kb1');
        if (!container) return;
        const words = data.vocabulary.filter(w => w.type !== 'kanji')
            .sort((a, b) => (a.kb1.steps[0] - b.kb1.steps[0]) || (b.kb1.in_class - a.kb1.in_class));
        ctx.renderMasterList(container, words, 'class words',
            w => `${w.base.kanji}（${w.base.kana}） ${w.meaning}${w.kb1.in_class ? '' : ' · extra'}`);
    }

    function options() {
        const steps = Array.from(document.querySelectorAll('[data-kb1-step]'))
            .filter(cb => cb.checked).map(cb => parseInt(cb.dataset.kb1Step, 10));
        const kanjiTypes = Array.from(document.querySelectorAll('[data-kb1-kanji-type]'))
            .filter(cb => cb.checked).map(cb => cb.dataset.kb1KanjiType);
        const examTypes = Array.from(document.querySelectorAll('[data-kb1-exam-type]'))
            .filter(cb => cb.checked).map(cb => cb.dataset.kb1ExamType);
        const num = (id, dflt) => { const v = parseInt($(id)?.value, 10); return Number.isFinite(v) && v > 0 ? v : dflt; };
        return {
            steps,
            includeExtra: !!($('kb1-include-extra') && $('kb1-include-extra').checked),
            exclude: new Set(ctx.knownIds()),
            kanjiTypes,
            examTypes,
            examCount: Math.min(200, num('kb1-exam-count', 50)),
            examMinutes: $('kb1-exam-timer')?.checked ? Math.min(180, num('kb1-exam-minutes', 50)) : 0,
        };
    }

    function mode() {
        return document.querySelector('input[name="kb1-mode"]:checked')?.value || 'kb1-reading-typed';
    }

    function isUnlocked() { return !!data; }
    function findWord(id) { return byId.get(id) || null; }

    function estimateHtml() {
        if (!data) return 'Estimated Flashcards: <span>Locked</span>';
        return `Estimated Flashcards: <span>${KB1Core.estimate(data, options(), mode())}</span>`;
    }

    // The entries a session draws from, or null (after telling the user why).
    function source() {
        if (!data) { alert('Please unlock the 漢字基礎１ tab first.'); return null; }
        const opts = options();
        if (!opts.steps.length) { alert('Please choose at least one Step.'); return null; }
        if (mode() === 'kb1-kanji' && !opts.kanjiTypes.length) { alert('Please choose at least one question type.'); return null; }
        if (mode() === 'kb1-exam' && !opts.examTypes.length) { alert('Please choose at least one question type.'); return null; }
        return { words: KB1Core.selectWords(data, opts), sentences: KB1Core.selectSentences(data, opts),
                 kanji: KB1Core.selectKanji(data, opts), special: KB1Core.specialWords(data, opts),
                 kanjiAll: data.vocabulary.filter(w => w.type === 'kanji'), opts };
    }

    return { init, isUnlocked, findWord, estimateHtml, source, mode, options };
})();
