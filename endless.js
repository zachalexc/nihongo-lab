// Endless mode (class tab), v2 "Flow": word → reading for as long as you like. New words keep coming
// while you're doing well, a miss comes back a few words later (retype, then one confirm), and a
// memory model (FSRS-6) decides which word is most useful next. srs_core.js is the engine,
// srs_store.js saves progress on this device (IndexedDB) and srs_content_kb.js turns the class
// words into items. Class words come from the decrypted kb1 bundle via KB1.endlessSource() and
// stay in memory.
window.Endless = (function () {
    'use strict';

    const Core = window.SrsCore, Store = window.SrsStore, Content = window.SrsContentKB;
    const $ = id => document.getElementById(id);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const isKanji = c => /[㐀-䶿一-鿿豈-﫿々]/.test(c);

    let ctx = null;          // from app.js: settingsSection, updateLiveEstimator, flashElementColor
    let store = null, storeReady = null;
    let meta = null, states = {}, log = [];
    let warnings = [];
    // session
    let items = [], classKanji = null, hoverMap = new Map(), sess = null, pick = null, last = null, phase = 'idle';
    let t0 = 0, paused = false, statsOpen = false, sum = null;
    let shownAt = 0;                           // when the prompt (or the retype box) appeared: the Enter guard
    let missFeedback = false;                  // the feedback screen after a miss is guarded too (the reading must be seen)
    let externalQueue = [];                    // class-mode answers waiting for the store to open
    let storeFailed = false;
    let storagePersistent = null;              // navigator.storage.persisted() result
    let installPrompt = null;                  // beforeinstallprompt event (Chrome, Edge, Android)

    // "Install app" for browsers that offer it; registered at load so the event isn't missed.
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        installPrompt = e;
        const btn = document.getElementById('endless-install-btn');
        if (btn) btn.classList.remove('hidden');
    });

    function init(context) {
        ctx = context;
        storeReady = Store.local().then(async s => {
            store = s;
            const d = await s.load();
            meta = d.meta; states = d.states; warnings = d.warnings || [];
            log = await s.getLog();
            renderWarnings();
            renderInstallTip();
            await flushExternal();
            ctx.updateLiveEstimator();
        }).catch(e => {
            console.warn('Endless: storage failed', e);
            externalQueue = []; storeFailed = true;     // evidence from other modes is dropped quietly
            warnings = ['Progress could not be loaded on this device: ' + (e && e.message || e)];
            renderWarnings();
        });
        if (navigator.storage && navigator.storage.persisted) {
            navigator.storage.persisted().then(v => { storagePersistent = v; }).catch(() => {});
        }
        $('endless-ios-tip-close').addEventListener('click', () => {
            if (meta) { meta.iosTipDismissed = true; store.saveMeta({ iosTipDismissed: true }); }
            $('endless-ios-tip').classList.add('hidden');
        });
        $('endless-install-btn').addEventListener('click', async () => {
            if (!installPrompt) return;
            installPrompt.prompt();
            try { await installPrompt.userChoice; } catch (_) { /* */ }
            installPrompt = null;
            $('endless-install-btn').classList.add('hidden');
        });

        $('endless-submit-btn').addEventListener('click', submitOrNext);
        $('endless-show-btn').addEventListener('click', showMe);
        $('endless-undo-btn').addEventListener('click', undo);
        $('endless-typo-btn').addEventListener('click', typo);
        $('endless-end-btn').addEventListener('click', endSession);
        $('endless-close-btn').addEventListener('click', backToSettings);
        $('endless-stats-btn').addEventListener('click', toggleStats);
        $('endless-stats-filter').addEventListener('change', renderStats);
        $('endless-export-btn').addEventListener('click', exportFile);
        $('endless-import-btn').addEventListener('click', () => {
            if (!confirm('Import a backup? It replaces the Endless progress saved on this device.')) return;
            $('endless-import-file').value = '';
            $('endless-import-file').click();
        });
        $('endless-import-file').addEventListener('change', importFile);
        $('endless-reset-btn').addEventListener('click', resetProgress);

        const input = $('endless-input');
        if (window.wanakana) window.wanakana.bind(input, { IMEMode: true });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.repeat) return;                                       // a held Enter never answers
                if (e.shiftKey) { showMe(); return; }                       // Shift+Enter = Show me
                submitOrNext();
            } else if (isUndoKey(e) && !input.value) { e.preventDefault(); undo(); }
        });
        document.addEventListener('keydown', e => {
            if ($('endless-section').classList.contains('hidden')) return;
            if (e.target === input) return;                                // handled above
            if (isUndoKey(e)) { e.preventDefault(); undo(); return; }
            if (phase !== 'feedback') return;
            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); if (!(missFeedback && settling())) next(); }
        });
        // The timer pauses when the tab is hidden or the window loses focus.
        document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
        window.addEventListener('blur', pause);
    }

    function pause() { if (phase === 'question') paused = true; }
    const isUndoKey = e => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z');
    // Enter / Submit / Show me are ignored for ENTER_GUARD_MS after a prompt or the retype box appears
    const settling = () => performance.now() - shownAt < Core.TUNING.ENTER_GUARD_MS;
    function hint(text) { const el = $('endless-hint'); el.textContent = text || ''; el.classList.toggle('hidden', !text); }

    // iOS Safari, not installed: Add to Home Screen keeps the storage (copied from match.js's tip)
    function renderInstallTip() {
        const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
        $('endless-ios-tip').classList.toggle('hidden', !(ios && !standalone && meta && !meta.iosTipDismissed));
    }

    // ---------------------------------------------------------------- evidence from the class modes
    // A first typed word → reading answer in a class mode (app.js gradeClassQuestion). Fire-and-forget:
    // never awaited by the caller, never throws, never changes the class flow.
    function recordExternal(word, correct, now) {
        try {
            if (storeFailed || !word || !word.base || !Content.hasKanji(word.base.kanji)) return;
            const ev = { key: Content.keyOf(word.base.kanji, word.base.kana), correct: !!correct, now: now || Date.now() };
            if (!meta || !store) { externalQueue.push(ev); return; }
            writeExternal(ev).catch(e => console.warn('Endless: external save failed', e));
        } catch (e) { console.warn('Endless: recordExternal failed', e); }
    }
    async function writeExternal(ev) {
        const r = Core.applyExternal(states[ev.key] || null, ev.correct, ev.now);
        if (!r) return;
        states[ev.key] = r.state;
        const entry = { k: ev.key, t: ev.now, c: ev.correct ? Core.CLS.CLEAN : Core.CLS.WRONG, r: null,
                        d: Core.localDay(ev.now), g: r.grade, R: Math.round(r.R * 1e4) / 1e4, f: 'x' };
        log.push(entry); while (log.length > Store.LOG_KEEP) log.shift();
        await store.saveAnswer({ key: ev.key, state: r.state, logEntry: entry });
    }
    async function flushExternal() {
        const q = externalQueue; externalQueue = [];
        for (const ev of q) { try { await writeExternal(ev); } catch (e) { console.warn('Endless: external save failed', e); } }
    }
    const elapsed = () => Math.round(performance.now() - t0);
    const retypeOn = () => !$('kb1-retype') || $('kb1-retype').checked;

    function renderWarnings() {
        const el = $('kb1-endless-warn');
        if (el) { el.textContent = warnings.join(' '); el.classList.toggle('hidden', !warnings.length); }
    }

    // ---------------------------------------------------------------- settings screen
    function poolItems(src) { return src ? Content.itemsFromWords(src.words).items : []; }

    // Estimator text; "…" until the store has loaded (never blocks).
    function estimateHtml(src) {
        const el = $('kb1-endless-summary');
        if (!meta || !src) {
            if (el) el.textContent = '';
            return 'Recall now: <span>…</span> · Long-term: <span>…</span> · Fading: <span>…</span>';
        }
        const pool = poolItems(src);
        const p = Core.progress(pool, states, [], Date.now());
        if (el) el.textContent = `${p.total} words in the pool · ${p.total - p.notStarted} started · ${p.mastered} mastered`;
        return `Recall now: <span>${p.recallNow}</span> · Long-term: <span>${p.longTerm}</span> · Fading: <span>${p.fading}</span>`;
    }

    // ---------------------------------------------------------------- session
    async function start(src) {
        if (!src) return;
        if (!meta) {
            try { await storeReady; } catch (_) { /* reported in warnings */ }
            if (!meta) { alert('Endless progress could not be loaded on this device.'); return; }
        }
        items = poolItems(src);
        if (!items.length) { alert('No words for the chosen Steps.'); return; }
        hoverMap = KB1Core.classKanji(src.kanjiAll, src.steps);      // same Steps as the pool
        classKanji = src.furigana === false ? null : hoverMap;
        if (!meta.persistAsked && navigator.storage && navigator.storage.persist) {
            meta.persistAsked = true;
            store.saveMeta({ persistAsked: true });
            navigator.storage.persist().then(v => { storagePersistent = v; }).catch(() => {});
        }
        sess = Core.newSession(meta.W);
        const now = Date.now();
        sum = { answers: 0, right: 0, graded: 0, fresh: 0, longTerm: new Set(), startRecall: Core.recallNow(items, states, now) };
        last = null;
        statsOpen = false;
        $('endless-stats').classList.add('hidden');
        fillStatsFilter();
        ctx.settingsSection.classList.add('hidden');
        $('endless-section').classList.remove('hidden');
        next();
    }

    const KIND_TAG = { new: 'new', relearn: 'relearn' };

    function next() {
        const now = Date.now();
        pick = Core.pickNext(items, states, sess, now);
        if (!pick) { endSession(); return; }
        const it = pick.item;
        $('endless-prompt').innerHTML =
            `<div class="kb1-word" lang="ja">${KB1Core.wordRubyHtml(it.src, classKanji)}</div>` +
            `<div class="kb1-instruction">Type the reading (hiragana or katakana)</div>`;
        $('endless-kind').textContent = KIND_TAG[pick.kind] || '';
        $('endless-feedback').innerHTML = '';
        $('endless-typo-btn').classList.add('hidden');
        $('endless-show-btn').classList.remove('hidden');               // every prompt (Shift+Enter)
        hint('');
        // the answer just given can still be undone on this prompt (the double-Enter case)
        $('endless-undo-btn').classList.toggle('hidden', !(last && last.answeredAt === sess.n && Core.canUndo(meta, last)));
        const input = $('endless-input');
        input.value = ''; input.readOnly = false; input.classList.remove('hidden', 'endless-retyping');
        input.placeholder = 'Type the reading…';
        $('endless-submit-btn').textContent = 'Submit';
        $('endless-submit-btn').disabled = false;
        $('endless-stop').classList.toggle('hidden', !Core.goodStop(items, states, sess, now));
        updateCounter(now);
        phase = 'question';
        paused = false;
        t0 = performance.now();
        shownAt = t0;
        input.focus();
    }

    function updateCounter(now) {
        $('endless-counter').textContent = `${sess.n} answers · recall now ${Math.round(Core.recallNow(items, states, now || Date.now()))}`;
    }

    function submitOrNext() {
        if (phase === 'feedback') { if (!(missFeedback && settling())) next(); return; }
        if (phase === 'done') { backToSettings(); return; }
        if (phase === 'retype') { if (!settling()) checkRetype(); return; }
        if (phase !== 'question' || settling()) return;
        const raw = $('endless-input').value;
        // an empty Enter never grades; nor does unfinished IME input (by its shape only)
        if (!raw.trim()) { hint('Type the reading, or press Show me if you don\'t know it'); return; }
        if (Core.unfinishedInput(raw)) { hint('Finish typing the reading, then press Enter'); return; }
        answer(raw, elapsed(), paused);
    }

    // Show me: on a word's first sight "I don't know it yet" (U); later it counts as wrong (W)
    function showMe() {
        if (phase !== 'question' || settling()) return;
        answer('', elapsed(), paused);
    }

    async function answer(raw, ms, wasPaused) {
        const now = Date.now();
        const it = pick.item;
        const prevState = states[it.key] || null;
        const res = Core.classify(it, raw, { ms, paused: wasPaused, baseline: Core.baselineOf(meta.baseline), firstSight: !prevState });
        const actx = { ratio: res.ratio, loop: pick.loop ? { need: pick.loop.need, fresh: !!pick.loop.fresh } : null };
        const r = Core.applyAnswer(prevState, res.cls, now, actx);
        // snapshots for "Undo": everything this answer changes
        const sessBefore = Core.cloneSession(sess), metaBefore = JSON.parse(JSON.stringify(meta));
        const sumBefore = Object.assign({}, sum, { longTerm: new Set(sum.longTerm) });
        states[it.key] = r.state;
        const loopBefore = JSON.parse(JSON.stringify(sess.loop));
        Core.recordAnswer(sess, pick, r);
        // pace
        const counted = Core.paceCounts(pick);
        const right = res.cls === 'C' || res.cls === 'S';
        const patch = { answerCount: (meta.answerCount || 0) + 1 };
        const pace = Core.updatePace(Object.assign({}, meta, patch), counted, right);
        patch.W = pace.W; patch.accWindow = pace.accWindow;
        sess.W = pace.W;
        if (res.cls === Core.CLS.CLEAN && !res.paused && !res.distracted && res.ratio !== null) {
            patch.baseline = Core.updateBaseline(meta.baseline, ms / res.mora);
        }
        Object.assign(meta, patch);
        // errors that teach
        const conf = (res.cls === 'W' || res.cls === 'N') ? Core.confusedWith(it, res.kana, items) : null;
        const entry = { k: it.key, t: now, c: res.cls, r: res.ratio === null ? null : Math.round(res.ratio * 100) / 100,
                        ms, m: res.mora, d: Core.localDay(now), g: r.grade, R: Math.round(r.R * 1e4) / 1e4 };
        if (res.paused || res.distracted) entry.f = res.distracted ? 'd' : 'p';
        if (conf) entry.conf = conf.key;
        log.push(entry); while (log.length > Store.LOG_KEEP) log.shift();
        last = { prevState, now, ctx: actx, pick, answeredAt: sess.n, cls: res.cls, kana: res.kana, typoUsed: false, counted, loopBefore,
                 sessBefore, metaBefore, sumBefore, entry, savePromise: null, undone: false };
        // session summary
        sum.answers++;
        if (res.cls !== 'U') { sum.graded++; if (right) sum.right++; }
        if (!prevState) sum.fresh++;
        if ((!prevState || prevState.s < Core.TUNING.LONG_TERM_S) && r.state.s >= Core.TUNING.LONG_TERM_S) sum.longTerm.add(it.key);
        showFeedback(it, res, r, conf);
        const mine = last;
        mine.savePromise = store.saveAnswer({ key: it.key, state: r.state, logEntry: entry, metaPatch: patch });
        try { mine.logId = await mine.savePromise; }
        catch (e) { console.warn('Endless: save failed', e); warnings = ['Saving failed: ' + (e && e.message || e)]; renderWarnings(); }
    }

    // "Undo — that Enter was a mistake": void the answer just given (U, or an unfinished entry), restoring the
    // word's state, meta, the session and the log; the word comes back after at least GAP_MISS items.
    async function undo() {
        if (!Core.canUndo(meta, last)) return;
        if (!(phase === 'feedback' || phase === 'retype' || (phase === 'question' && last.answeredAt === sess.n))) return;
        const u = last;
        u.undone = true;
        const onPrompt = phase === 'question';
        try { await u.savePromise; } catch (_) { /* nothing was stored */ }
        const key = u.pick.item.key;
        if (u.prevState) states[key] = u.prevState; else delete states[key];
        meta = Object.assign(JSON.parse(JSON.stringify(u.metaBefore)), { undoLastAt: u.metaBefore.answerCount || 0 });
        const keepPick = onPrompt ? pick : null;
        sess = Core.holdAfterVoid(Core.cloneSession(u.sessBefore), key, !u.prevState);
        sum = u.sumBefore;
        const i = log.lastIndexOf(u.entry); if (i >= 0) log.splice(i, 1);
        const now = Date.now();
        const voidEntry = { k: key, t: now, c: Core.CLS.VOID };
        log.push(voidEntry);
        last = null;
        const input = $('endless-input'); input.oninput = null;
        try { await store.voidAnswer({ key, prevState: u.prevState, metaSnapshot: meta, logId: u.logId, voidEntry }); }
        catch (e) { console.warn('Endless: undo failed', e); warnings = ['Saving failed: ' + (e && e.message || e)]; renderWarnings(); }
        if (onPrompt && keepPick && keepPick.item.key !== key) {
            // stay on this prompt; restart its timer, marked paused for this answer
            pick = keepPick;
            $('endless-undo-btn').classList.add('hidden');
            updateCounter(now);
            phase = 'question';
            t0 = performance.now(); shownAt = t0; paused = true;
            input.value = ''; input.focus();
        } else {
            next();
        }
        hint('Undone — it\'ll come back in a few words');
    }

    // The reading over the word, part by part (furigana split); falls back to "word (reading)".
    function readingHtml(it) {
        const parts = it.split && it.split.length ? it.split : null;
        if (!parts) return `<span lang="ja">${esc(it.text)}</span> (<span lang="ja">${esc(it.reading)}</span>)`;
        return '<span class="endless-ruby" lang="ja">' + parts.map(([text, reading]) =>
            Array.from(text).some(isKanji) && reading ? `<ruby>${esc(text)}<rt>${esc(reading)}</rt></ruby>` : esc(text)).join('') + '</span>';
    }

    const CLASS_TEXT = { C: 'Correct', S: 'Correct — slow', N: 'Near miss — looks like a typo', W: 'Not quite', U: 'New word', T: 'Counted as a typo' };

    function showFeedback(it, res, r, conf) {
        const ok = res.cls === 'C' || res.cls === 'S';
        const input = $('endless-input');
        $('endless-show-btn').classList.add('hidden');
        const alt = it.altAnswers.length ? ` <span class="kb1-meaning">(also ${it.altAnswers.map(esc).join('・')})</span>` : '';
        const yours = (ok || res.cls === 'U') ? '' : `<div class="kb1-yours"><span lang="en">Your answer:</span> <span lang="ja">${esc(res.kana || input.value)}</span></div>`;
        let head = `<span class="${ok ? 'kb1-ok' : 'kb1-ng'}">${ok ? '✓' : res.cls === 'U' ? '•' : '✗'}</span> ${esc(CLASS_TEXT[res.cls])}`;
        if (r.fastTrack) head += ' · <span class="endless-known">Known already ✓</span>';
        if (r.mastered) head += ' · 🎓 mastered';
        $('endless-feedback').innerHTML =
            `<div class="kb1-feedback endless-class endless-${res.cls}">${head}</div>` + yours +
            `<div class="kb1-answer endless-answer">${readingHtml(it)} <span class="endless-eq">=</span> <span lang="ja">${esc(it.reading)}</span>${alt} · ${esc(it.gloss)}</div>` +
            (conf ? `<div class="endless-conf">That's the reading of <span lang="ja">${esc(conf.text)}</span> (<span lang="ja">${esc(conf.reading)}</span>).</div>` : '');
        if (!ok && res.cls !== 'U') {
            // the kanji hover cards (as in the class word → reading mode), same Steps as the furigana
            const w = $('endless-prompt').querySelector('.kb1-word');
            if (w && KB1Core.wordHoverHtml) w.innerHTML = KB1Core.wordHoverHtml(it.src, hoverMap, !!classKanji);
        }
        $('endless-typo-btn').classList.toggle('hidden', !Core.canTypo(meta, last));
        $('endless-undo-btn').classList.toggle('hidden', !Core.canUndo(meta, last));
        hint('');
        updateCounter();
        if (statsOpen) renderStats();
        if (r.retype && retypeOn()) {
            phase = 'retype';
            input.value = ''; input.readOnly = false; input.classList.add('endless-retyping');
            input.placeholder = 'Type the reading to continue…';
            $('endless-submit-btn').textContent = 'Next →';
            $('endless-submit-btn').disabled = true;
            shownAt = performance.now();                                 // the guard covers the retype box too
            input.focus();
            input.oninput = () => { $('endless-submit-btn').disabled = !input.value.trim(); };
        } else {
            phase = 'feedback';
            // after a miss (W, N, U) the reading must be seen: Enter / Space / Next wait ENTER_GUARD_MS;
            // after a correct answer Enter moves on at once
            missFeedback = !ok;
            if (missFeedback) shownAt = performance.now();
            input.readOnly = true;
            $('endless-submit-btn').textContent = 'Next →';
            $('endless-submit-btn').disabled = false;
            $('endless-submit-btn').focus();
        }
    }

    // Retype after a miss: the right reading moves on; anything else flashes and is erased.
    function checkRetype() {
        const input = $('endless-input');
        if (!input.value.trim()) return;
        const it = pick.item;
        const exp = [...it.answers, ...it.altAnswers].map(Core.toHiragana);
        const { kana } = Core.normalize(input.value, exp);
        if (exp.includes(kana)) { input.oninput = null; next(); return; }
        ctx.flashElementColor(input, 'var(--error-color)');
        input.value = '';
        $('endless-submit-btn').disabled = true;
    }

    async function typo() {
        if ((phase !== 'feedback' && phase !== 'retype') || !Core.canTypo(meta, last)) return;
        const key = last.pick.item.key;
        sess.loop = JSON.parse(JSON.stringify(last.loopBefore));
        const r = Core.applyTypo(sess, last);
        states[key] = r.state;
        last.typoUsed = true;
        meta.typoLastAt = meta.answerCount;
        const patch = { typoLastAt: meta.typoLastAt };
        if (last.counted && meta.accWindow.length) {              // the answer now counts as right for the pace
            meta.accWindow = meta.accWindow.slice(); meta.accWindow[meta.accWindow.length - 1] = true;
            patch.accWindow = meta.accWindow;
        }
        const now = Date.now();
        const entry = { k: key, t: now, c: Core.CLS.TYPO, r: null, d: Core.localDay(now), g: r.grade };
        log.push(entry);
        $('endless-typo-btn').classList.add('hidden');
        $('endless-undo-btn').classList.add('hidden');
        const head = $('endless-feedback').querySelector('.endless-class');
        if (head) { head.className = 'kb1-feedback endless-class endless-T'; head.innerHTML = `<span class="kb1-ng">~</span> ${CLASS_TEXT.T} (near miss)`; }
        const input = $('endless-input');
        input.oninput = null; input.readOnly = true; input.classList.remove('endless-retyping');
        phase = 'feedback';
        missFeedback = true;                                          // T is still a miss: the guard stays
        $('endless-submit-btn').disabled = false;
        $('endless-submit-btn').focus();
        try { await store.saveAnswer({ key, state: r.state, logEntry: entry, metaPatch: patch }); }
        catch (e) { console.warn('Endless: save failed', e); }
    }

    function endSession() {
        const now = Date.now();
        const s = sum || { answers: 0, right: 0, graded: 0, fresh: 0, longTerm: new Set(), startRecall: 0 };
        const acc = s.graded ? Math.round(100 * s.right / s.graded) + '%' : '—';
        const endRecall = Math.round(Core.recallNow(items, states, now));
        $('endless-prompt').innerHTML = `<div class="endless-summary"><div class="kb1-instruction">Session finished</div>` +
            `<div id="endless-summary-line">+${s.fresh} new words · ${s.longTerm.size} now long-term · recall now ${Math.round(s.startRecall)} → ${endRecall} · accuracy ${acc}</div>` +
            `<div class="endless-statline">${s.answers} answers</div></div>`;
        $('endless-feedback').innerHTML = '';
        $('endless-kind').textContent = '';
        $('endless-stop').classList.add('hidden');
        const input = $('endless-input');
        input.oninput = null;
        input.classList.add('hidden');
        $('endless-typo-btn').classList.add('hidden');
        $('endless-show-btn').classList.add('hidden');
        $('endless-undo-btn').classList.add('hidden');
        hint('');
        last = null;
        $('endless-submit-btn').textContent = 'Back to Settings';
        $('endless-submit-btn').disabled = false;
        phase = 'done';
    }

    function backToSettings() {
        phase = 'idle';
        $('endless-section').classList.add('hidden');
        $('endless-input').classList.remove('hidden');
        ctx.settingsSection.classList.remove('hidden');
        ctx.updateLiveEstimator();
    }

    // ---------------------------------------------------------------- stats
    function fillStatsFilter() {
        const sel = $('endless-stats-filter');
        const tags = [...new Set(items.flatMap(it => it.tags))].sort((a, b) => parseInt(a.slice(7), 10) - parseInt(b.slice(7), 10));
        sel.innerHTML = '<option value="">All Steps</option>' + tags.map(t => `<option value="${esc(t)}">Step ${esc(t.slice(7))}</option>`).join('');
    }
    function toggleStats() {
        statsOpen = !statsOpen;
        $('endless-stats').classList.toggle('hidden', !statsOpen);
        if (statsOpen) renderStats();
    }
    function renderStats() {
        const tag = $('endless-stats-filter').value || null;
        const p = Core.progress(items, states, log, Date.now(), tag);
        const max = Math.max(1, ...p.bands);
        const bars = p.bands.map((n, i) =>
            `<div class="endless-band"><span class="endless-band-label">${esc(p.bandLabels[i])}</span>` +
            `<span class="endless-band-bar"><span style="width:${Math.round(100 * n / max)}%"></span></span><b>${n}</b></div>`).join('');
        $('endless-stats-body').innerHTML =
            `<div class="endless-statline endless-headline">Recall now <b>${p.recallNow}</b> · Long-term <b>${p.longTerm}</b> · Mastered <b>${p.mastered}</b></div>` +
            `<div class="endless-statline">${p.learning} learning · ${p.notStarted} not started · ${p.fading} fading · working set ${sess ? sess.W : meta.W}</div>` +
            `<div class="endless-statline">Accuracy ${p.accuracy === null ? '—' : Math.round(100 * p.accuracy) + '%'} (${p.answers} answers) · ` +
            `median speed ${p.medianMsPerMora === null ? '—' : (p.medianMsPerMora / 1000).toFixed(2) + ' s per mora'}</div>` +
            `<div class="endless-bands"><div class="endless-statline">How long words last (stability)</div>${bars}</div>` +
            (storagePersistent === null ? '' : `<div class="endless-statline" id="endless-storage">Storage: ${storagePersistent ? 'persistent' : 'may be cleared by the browser'}</div>`);
        $('endless-stats-body').dataset.json = JSON.stringify(p);
    }

    // ---------------------------------------------------------------- export / import / reset
    async function exportFile() {
        if (!store) { try { await storeReady; } catch (_) { /* */ } }
        if (!store) return;
        const obj = await store.exportAll();
        const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `nihongo-endless-${Core.localDay(Date.now())}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        await store.saveMeta({ lastExportAt: Date.now() });
        meta.lastExportAt = Date.now();
    }

    async function importFile(e) {
        const f = e.target.files && e.target.files[0];
        if (!f || !store) return;
        try {
            const obj = JSON.parse(await f.text());
            const s = store.summary(obj);
            await store.importAll(obj);
            await reload();
            setNote(`Imported ${s.items} words (${s.mastered} mastered, ${s.answers} logged answers).`);
        } catch (err) {
            setNote('Import failed: ' + (err && err.message || err));
        }
    }

    async function resetProgress() {
        if (!store) return;
        if (!confirm('Reset all Endless progress on this device? This cannot be undone. Use Export first if you might want it back.')) return;
        await store.reset();
        await reload();
        setNote('Endless progress was reset.');
    }

    async function reload() {
        const d = await store.load();
        meta = d.meta; states = d.states; log = await store.getLog();
        ctx.updateLiveEstimator();
    }
    function setNote(text) { const el = $('kb1-endless-note'); if (el) el.textContent = text; }

    // For tests
    function _state() { return { meta, states, log, sess, pick, phase, items: items.length, backend: store && store.backend.kind, warnings, shownAt, paused, last: last && { cls: last.cls, kana: last.kana, answeredAt: last.answeredAt } }; }
    async function _seed(newStates) {          // tests: replace the stored states
        for (const [k, s] of Object.entries(newStates)) { states[k] = s; await store.saveAnswer({ key: k, state: s }); }
    }

    return { init, start, estimateHtml, recordExternal, _state, _seed, ready: () => storeReady,
             _queue: () => externalQueue.length };
})();
