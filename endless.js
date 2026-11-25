// Endless mode, v2 "Flow": word → reading for as long as you like. New words keep coming
// while you're doing well, a miss comes back a few words later (retype, then one confirm), and a
// memory model (FSRS-6) decides which word is most useful next. srs_core.js is the engine,
// srs_store.js saves progress on this device (IndexedDB). Two sources share one store (and one sync):
// - the class tab ('kb'): srs_content_kb.js turns the class words from the decrypted kb1 bundle
//   (KB1.endlessSource()) into items; they stay in memory;
// - the public JLPT tab ('jlpt', phase 4): srs_content_jlpt.js loads the JLPT word lists lazily. A JLPT
//   session never calls KB1 or KB1Core: no prompt furigana, no kanji hover cards (the reading line after
//   an answer shows the item's own furigana split).
// The shared controls (Export/Import/Reset, cloud sync, notes, tips) are one block, moved into the visible
// tab by attachShared().
// Several readings of one spelling (round 12): siblings in the pool (SrsCore.siblings). On a Hinted item the prompt
// says which meaning is wanted and a sibling's reading is an "other reading" (A): not graded, asked again.
window.Endless = (function () {
    'use strict';

    const Core = window.SrsCore, Store = window.SrsStore, Content = window.SrsContentKB, ContentJ = window.SrsContentJLPT;
    const Sync = window.SrsSync, Cloud = window.NLCloud;
    const $ = id => document.getElementById(id);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const isKanji = c => /[㐀-䶿一-鿿豈-﫿々]/.test(c);

    let ctx = null;          // from app.js: settingsSection, updateLiveEstimator, flashElementColor
    let store = null, storeReady = null;
    let meta = null, states = {}, log = [];
    const logKeep = () => (store && store.backend && store.backend.logKeep) || Store.LOG_KEEP_LS;   // the store's own limit
    let warnings = [];
    // session
    let items = [], classKanji = null, hoverMap = new Map(), sess = null, pick = null, last = null, phase = 'idle';
    let srcKind = 'kb';                        // the running session's source: 'kb' (class) | 'jlpt'
    let sibMap = new Map();                    // the pool's siblings (same spelling, other reading)
    let promptA = 0;                           // "other reading" answers on the current prompt
    // Optional hints ('spelling|reading' -> short English text) that replace a gloss for telling siblings apart.
    // Public words only (never a class-only word).
    const SIBLING_HINTS = {};
    let t0 = 0, paused = false, statsOpen = false, sum = null;
    let shownAt = 0;                           // when the prompt (or the retype box) appeared: the Enter guard
    let missFeedback = false;                  // the feedback screen after a miss is guarded too (the reading must be seen)
    let externalQueue = [];                    // class-mode answers waiting for the store to open
    let storeFailed = false;
    let storagePersistent = null;              // navigator.storage.persisted() result
    let installPrompt = null;                  // beforeinstallprompt event (Chrome, Edge, Android)
    // cloud sync (phase 3): user = the signed-in Google account; status: 'off' | 'syncing' | 'ok' | 'offline' | 'quota'
    const cloud = { user: null, status: 'off', lastSyncAt: 0, answersSinceSync: 0, pausedUntil: 0, failed: false,
                    running: null, again: null, note: '', syncs: 0, started: false };

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
            if (!confirm(meta && meta.uid
                ? 'Import a backup? It replaces all Endless progress (class and JLPT) on this device, in the cloud and on your other devices.'
                : 'Import a backup? It replaces all Endless progress (class and JLPT) saved on this device.')) return;
            $('endless-import-file').value = '';
            $('endless-import-file').click();
        });
        $('endless-import-file').addEventListener('change', importFile);
        $('endless-reset-btn').addEventListener('click', resetProgress);
        $('endless-signin-btn').addEventListener('click', signIn);
        $('endless-signout-btn').addEventListener('click', () => signOut(''));
        $('endless-delete-cloud-btn').addEventListener('click', deleteCloudData);
        storeReady.then(() => { renderCloud(); if (rememberedSignIn()) startCloud(false); });
        initJlpt();

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
        document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); maybeSync('hidden'); } });
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
        const patch = touched(ev.key, r.state);
        Object.assign(meta, patch);
        const entry = { k: ev.key, t: ev.now, c: ev.correct ? Core.CLS.CLEAN : Core.CLS.WRONG, r: null,
                        d: Core.localDay(ev.now), g: r.grade, R: Math.round(r.R * 1e4) / 1e4, f: 'x' };
        log.push(entry); while (log.length > logKeep()) log.shift();
        await store.saveAnswer({ key: ev.key, state: r.state, logEntry: entry, metaPatch: patch });
        cloud.answersSinceSync++;
        maybeSync('answers');
    }
    async function flushExternal() {
        const q = externalQueue; externalQueue = [];
        for (const ev of q) { try { await writeExternal(ev); } catch (e) { console.warn('Endless: external save failed', e); } }
    }
    const elapsed = () => Math.round(performance.now() - t0);
    const retypeOn = () => {
        const box = $(srcKind === 'jlpt' ? 'jlpt-retype' : 'kb1-retype');
        return !box || box.checked;
    };
    const kindOf = src => (src && src.kind === 'jlpt' ? 'jlpt' : 'kb');

    function renderWarnings() {
        const el = $('kb1-endless-warn');
        if (el) { el.textContent = warnings.join(' '); el.classList.toggle('hidden', !warnings.length); }
    }

    // ---------------------------------------------------------------- settings screen
    // kb: the class words; jlpt: the loaded JLPT items of the ticked levels (+ the beyond words when on)
    function poolItems(src) {
        if (!src) return [];
        if (kindOf(src) === 'jlpt') {
            const lv = new Set(src.levels || []);
            return src.items.filter(it => (it.level ? lv.has(it.level) : !!src.beyond));
        }
        return Content.itemsFromWords(src.words).items;
    }

    // Estimator text; "…" until the store has loaded (never blocks). The numbers count this tab's pool only.
    function estimateHtml(src) {
        const el = $(kindOf(src) === 'jlpt' ? 'jlpt-endless-summary' : 'kb1-endless-summary');
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
        const kind = kindOf(src);
        const pool = poolItems(src);
        if (!pool.length) { alert(kind === 'jlpt' ? 'No words for the chosen levels.' : 'No words for the chosen Steps.'); return; }
        items = pool; srcKind = kind;
        sibMap = Core.siblings(pool, SIBLING_HINTS);
        if (kind === 'kb') {
            hoverMap = KB1Core.classKanji(src.kanjiAll, src.steps);  // same Steps as the pool
            classKanji = src.furigana === false ? null : hoverMap;
        } else { hoverMap = new Map(); classKanji = null; }        // JLPT: no class data at all
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
        const word = srcKind === 'kb' ? KB1Core.wordRubyHtml(it.src, classKanji) : esc(it.text);   // JLPT: the spelling only
        const sib = sibMap.get(it.key) || null;
        pick.sib = sib; pick.gi = Core.withSiblings(it, sib);           // the item as graded (accepted readings)
        promptA = 0;
        const sibLine = !sib ? '' : `<div class="kb1-instruction endless-sib">${sib.count} readings` +
            (sib.kind === 'hinted' ? ` · here: <span class="endless-here">${esc(sib.here)}</span>` : '') + '</div>';
        $('endless-prompt').innerHTML =
            `<div class="kb1-word${srcKind === 'jlpt' ? ' endless-word' : ''}" lang="ja">${word}</div>` + sibLine +
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

    // A Hinted item answered with a sibling's reading: not graded; say so and ask again on the same prompt
    function otherReadingAsk(it, o, sib) {
        promptA++;
        const now = Date.now();
        const entry = { k: it.key, t: now, c: Core.CLS.OTHER, alt: o.key };
        log.push(entry); while (log.length > logKeep()) log.shift();
        store.saveAnswer({ key: null, logEntry: entry }).catch(e => console.warn('Endless: save failed', e));
        hint(`Yes, ${it.text} can be read ${o.reading} (${o.gloss}). Here it means "${sib.here}". Which reading fits?`);
        $('endless-hint').classList.add('endless-other');
        $('endless-undo-btn').classList.add('hidden');
        const input = $('endless-input'); input.value = ''; input.focus();
        t0 = performance.now(); shownAt = t0; paused = true;            // the timer restarts, marked paused; guarded again
    }

    async function answer(raw, ms, wasPaused) {
        const now = Date.now();
        const it = pick.item;
        const sib = pick.sib || null, gi = pick.gi || it;
        let forceWrong = false;
        if (raw && sib) {
            const o = Core.otherReading(it, raw, sib);
            if (o) { if (promptA === 0) { otherReadingAsk(it, o, sib); return; } forceWrong = true; }   // a second A -> W
        }
        const prevState = states[it.key] || null;
        const res = Core.classify(gi, raw, { ms, paused: wasPaused, baseline: Core.baselineOf(meta.baseline), firstSight: !prevState });
        if (forceWrong) { res.cls = Core.CLS.WRONG; res.matched = null; }
        else if (promptA > 0 && (res.cls === Core.CLS.CLEAN || res.cls === Core.CLS.SLOW)) res.cls = Core.CLS.SLOW;   // right after an A: Hard
        const actx = { ratio: res.ratio, loop: pick.loop ? { need: pick.loop.need, fresh: !!pick.loop.fresh } : null };
        if (promptA > 0) actx.noFastTrack = true;
        const r = Core.applyAnswer(prevState, res.cls, now, actx);
        // snapshots for "Undo": everything this answer changes
        const sessBefore = Core.cloneSession(sess), metaBefore = JSON.parse(JSON.stringify(meta));
        const cloudPatch = touched(it.key, r.state);
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
        if (meta.uid && (patch.W !== meta.W || patch.baseline)) patch.wbMt = now;
        Object.assign(patch, cloudPatch);
        Object.assign(meta, patch);
        // errors that teach
        let conf = (res.cls === 'W' || res.cls === 'N') ? Core.confusedWith(it, res.kana, items) : null;
        if (conf && sib && sib.others.some(o => o.key === conf.key)) conf = null;     // siblings get "Also read" instead
        const entry = { k: it.key, t: now, c: res.cls, r: res.ratio === null ? null : Math.round(res.ratio * 100) / 100,
                        ms, m: res.mora, d: Core.localDay(now), g: r.grade, R: Math.round(r.R * 1e4) / 1e4,
                        w: metaBefore.W };                                   // the working set before this answer's pace update
        if (res.paused || res.distracted) entry.f = res.distracted ? 'd' : 'p';
        if (conf) entry.conf = conf.key;
        log.push(entry); while (log.length > logKeep()) log.shift();
        last = { metaAfterWB: JSON.parse(JSON.stringify(meta.baseline || [])), wAfter: meta.W, prevState, now, ctx: actx, pick, answeredAt: sess.n, cls: res.cls, kana: res.kana, typoUsed: false, counted, loopBefore,
                 sessBefore, metaBefore, sumBefore, entry, savePromise: null, undone: false };
        // session summary
        sum.answers++;
        if (res.cls !== 'U') { sum.graded++; if (right) sum.right++; }
        if (!prevState) sum.fresh++;
        if ((!prevState || prevState.s < Core.TUNING.LONG_TERM_S) && r.state.s >= Core.TUNING.LONG_TERM_S) sum.longTerm.add(it.key);
        $('endless-hint').classList.remove('endless-other');
        showFeedback(it, res, r, conf, sib);
        const mine = last;
        mine.savePromise = store.saveAnswer({ key: it.key, state: r.state, logEntry: entry, metaPatch: patch });
        try { mine.logId = await mine.savePromise; }
        catch (e) { console.warn('Endless: save failed', e); warnings = ['Saving failed: ' + (e && e.message || e)]; renderWarnings(); }
        cloud.answersSinceSync++;
        maybeSync('answers');
    }

    // "Undo — that Enter was a mistake": void the answer just given (U, or an unfinished entry), restoring the
    // word's state, meta, the session and the log; the word comes back after at least GAP_MISS items.
    async function undo() {
        if (!Core.canUndo(meta, last)) return;
        if (!(phase === 'feedback' || phase === 'retype' || (phase === 'question' && last.answeredAt === sess.n && promptA === 0))) return;
        const u = last;
        u.undone = true;
        const onPrompt = phase === 'question';
        try { await u.savePromise; } catch (_) { /* nothing was stored */ }
        const key = u.pick.item.key;
        const vnow = Date.now();
        const cur = states[key] || null;
        const keepCloud = {};
        for (const f of Store.CLOUD_FIELDS) keepCloud[f] = JSON.parse(JSON.stringify(meta[f] === undefined ? null : meta[f]));
        // restore the values with a new revision (or a tombstone for an undone first sight) so a sync can't bring them back
        const nextRev = Math.max(cur && cur.rev || 0, keepCloud.tombs && keepCloud.tombs[key] ? keepCloud.tombs[key].rev : 0) + 1;
        const restored = u.prevState ? Object.assign({}, u.prevState, { rev: nextRev, mt: vnow }) : null;
        if (restored) states[key] = restored; else delete states[key];
        meta = Object.assign(JSON.parse(JSON.stringify(u.metaBefore)), keepCloud, { undoLastAt: u.metaBefore.answerCount || 0 });
        if (meta.uid) {
            meta.tombs = Object.assign({}, meta.tombs);
            if (restored) delete meta.tombs[key]; else meta.tombs[key] = { rev: nextRev, mt: vnow };
            if (!meta.dirty.includes(key)) meta.dirty = meta.dirty.concat([key]);
            if (u.metaBefore.W !== u.wAfter || JSON.stringify(u.metaBefore.baseline || []) !== JSON.stringify(u.metaAfterWB)) meta.wbMt = vnow;
        }
        const keepPick = onPrompt ? pick : null;
        sess = Core.holdAfterVoid(Core.cloneSession(u.sessBefore), key, !u.prevState);
        sum = u.sumBefore;
        const i = log.lastIndexOf(u.entry); if (i >= 0) log.splice(i, 1);
        const now = Date.now();
        const voidEntry = { k: key, t: now, c: Core.CLS.VOID };
        log.push(voidEntry);
        last = null;
        const input = $('endless-input'); input.oninput = null;
        try { await store.voidAnswer({ key, prevState: restored, metaSnapshot: meta, logId: u.logId, voidEntry }); }
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

    function showFeedback(it, res, r, conf, sib) {
        const ok = res.cls === 'C' || res.cls === 'S';
        const input = $('endless-input');
        $('endless-show-btn').classList.add('hidden');
        // other readings of the same spelling are listed with their meanings ("Also read"), not in "(also …)"
        const sibR = new Set(sib ? sib.others.flatMap(o => o.answers) : []);
        const alts = it.altAnswers.filter(a => !sibR.has(Core.toHiragana(a)));
        const alt = alts.length ? ` <span class="kb1-meaning">(also ${alts.map(esc).join('・')})</span>` : '';
        const also = sib ? `<div class="endless-also">Also read: ` + sib.others.map(o =>
            `<span lang="ja">${esc(o.reading)}</span> (${esc(o.gloss)})`).join(' · ') + '</div>' : '';
        const yours = (ok || res.cls === 'U') ? '' : `<div class="kb1-yours"><span lang="en">Your answer:</span> <span lang="ja">${esc(res.kana || input.value)}</span></div>`;
        const label = res.cls === 'S' && promptA > 0 ? 'Correct — on the second try' : CLASS_TEXT[res.cls];   // after an other reading (A): still S
        let head = `<span class="${ok ? 'kb1-ok' : 'kb1-ng'}">${ok ? '✓' : res.cls === 'U' ? '•' : '✗'}</span> ${esc(label)}`;
        if (r.fastTrack) head += ' · <span class="endless-known">Known already ✓</span>';
        if (r.mastered) head += ' · 🎓 mastered';
        $('endless-feedback').innerHTML =
            `<div class="kb1-feedback endless-class endless-${res.cls}">${head}</div>` + yours +
            `<div class="kb1-answer endless-answer">${readingHtml(it)} <span class="endless-eq">=</span> <span lang="ja">${esc(it.reading)}</span>${alt} · ${esc(it.gloss)}</div>` +
            also +
            (conf ? `<div class="endless-conf">That's the reading of <span lang="ja">${esc(conf.text)}</span> (<span lang="ja">${esc(conf.reading)}</span>).</div>` : '');
        if (!ok && res.cls !== 'U' && srcKind === 'kb') {
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
        const it = pick.gi || pick.item;                              // a Hinted item's siblings don't count here either
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
        const patch = Object.assign({ typoLastAt: meta.typoLastAt }, touched(key, r.state));
        Object.assign(meta, patch);
        if (last.counted && meta.accWindow.length) {              // the answer now counts as right for the pace
            meta.accWindow = meta.accWindow.slice(); meta.accWindow[meta.accWindow.length - 1] = true;
            patch.accWindow = meta.accWindow;
        }
        const now = Date.now();
        const entry = { k: key, t: now, c: Core.CLS.TYPO, r: null, d: Core.localDay(now), g: r.grade, w: last.metaBefore.W };
        log.push(entry); while (log.length > logKeep()) log.shift();
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
            `<div class="endless-statline">${s.answers} answers</div>` +
            (srcKind === 'jlpt' && jlptAllStarted() ? `<div class="endless-statline" id="endless-all-started">All JLPT words are started. ` +
                `<button type="button" id="endless-add-beyond-btn" class="btn btn-secondary">Add words beyond JLPT</button></div>` : '') +
            `</div>`;
        const addBtn = $('endless-add-beyond-btn');
        if (addBtn) addBtn.addEventListener('click', addBeyondAndContinue);
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
        maybeSync('end');
    }

    function backToSettings() {
        phase = 'idle';
        $('endless-section').classList.add('hidden');
        $('endless-input').classList.remove('hidden');
        ctx.settingsSection.classList.remove('hidden');
        ctx.updateLiveEstimator();
    }

    // ---------------------------------------------------------------- stats
    // by tag prefix: kb:stepN -> "Step N"; jlpt:nN -> "NN" (N5 first); jlpt:beyond -> "Beyond JLPT"
    const tagLabel = t => (t.startsWith('kb:step') ? 'Step ' + t.slice(7) : t === 'jlpt:beyond' ? 'Beyond JLPT' : t.startsWith('jlpt:n') ? 'N' + t.slice(6) : t);
    const tagRank = t => (t.startsWith('kb:step') ? parseInt(t.slice(7), 10) : t === 'jlpt:beyond' ? 100 : t.startsWith('jlpt:n') ? 10 - parseInt(t.slice(6), 10) : 1000);
    function fillStatsFilter() {
        const sel = $('endless-stats-filter');
        const tags = [...new Set(items.flatMap(it => it.tags))].sort((a, b) => tagRank(a) - tagRank(b));
        sel.innerHTML = `<option value="">${srcKind === 'jlpt' ? 'All levels' : 'All Steps'}</option>` +
            tags.map(t => `<option value="${esc(t)}">${esc(tagLabel(t))}</option>`).join('');
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
            await waitIdle();
            const keep = cloudFields();
            await store.importAll(obj);
            if (keep.uid) await store.saveMeta(Object.assign(keep, { dirty: [], tombs: {}, pendingReset: true }));
            await reload();
            if (keep.uid) maybeSync('reset');
            setNote(`Imported ${s.items} words (${s.mastered} mastered, ${s.answers} logged answers).`);
        } catch (err) {
            setNote('Import failed: ' + (err && err.message || err));
        }
    }

    async function resetProgress() {
        if (!store) return;
        const synced = !!(meta && meta.uid);
        if (!confirm(synced
            ? 'Reset all Endless progress (class and JLPT) on this device and in the cloud (your other devices too)? This cannot be undone. Use Export first if you might want it back.'
            : 'Reset all Endless progress (class and JLPT) on this device? This cannot be undone. Use Export first if you might want it back.')) return;
        await waitIdle();
        const keep = cloudFields();
        await store.reset();
        if (synced) await store.saveMeta(Object.assign(keep, { dirty: [], tombs: {}, pendingReset: true }));
        await reload();
        setNote('Endless progress was reset.');
        if (synced) maybeSync('reset');
    }

    async function reload() {
        const d = await store.load();
        meta = d.meta; states = d.states; log = await store.getLog();
        ctx.updateLiveEstimator();
    }
    function setNote(text) { const el = $('kb1-endless-note'); if (el) el.textContent = text; }


    // ---------------------------------------------------------------- shared controls
    // One #endless-shared block (Export/Import/Reset, cloud line, note, warnings, iOS tip, Install), moved into the
    // visible tab's host, so every id exists once in the document.
    function attachShared(which) {
        const block = $('endless-shared'), host = $(which === 'jlpt' ? 'jlpt-shared-host' : 'kb1-endless-shared-host');
        if (block && host && block.parentNode !== host) host.appendChild(block);
    }

    // ---------------------------------------------------------------- JLPT tab (phase 4)
    // The word list loads the first time the tab is shown; the beyond list only on opt-in. Nothing here reads class data.
    const jlpt = { status: 'idle', words: null, err: null, beyond: null, beyondStatus: 'idle', beyondErr: null, all: null };
    const LEVELS = [5, 4, 3, 2, 1];
    const OFFLINE_MSG = 'The JLPT word list hasn\'t been downloaded yet. Connect to the internet once; after that it works offline.';
    const jlptLevels = () => LEVELS.filter(l => $('jlpt-lv-' + l) && $('jlpt-lv-' + l).checked);
    const jlptBeyondOn = () => !!($('jlpt-beyond') && $('jlpt-beyond').checked);

    function initJlpt() {
        if (!$('tab-jlpt')) return;
        const info = ContentJ && ContentJ.BEYOND_INFO;
        if (info && $('jlpt-beyond-label')) {
            $('jlpt-beyond-label').textContent = `Beyond JLPT: about ${(Math.round(info.words / 100) * 100).toLocaleString('en-US')} more common words (~${info.gzipKB} KB download)`;
        }
        $('jlpt-retry-btn').addEventListener('click', () => {
            if (jlpt.status !== 'ready') loadJlpt(); else if (jlptBeyondOn()) loadBeyond();
        });
        $('jlpt-beyond').addEventListener('change', () => { if (jlptBeyondOn() && jlpt.status === 'ready') loadBeyond(); renderJlpt(); });
        $('jlpt-add-beyond-btn').addEventListener('click', () => setBeyond(true));
    }
    // app.js calls this when the JLPT tab is shown
    function jlptShown() {
        attachShared('jlpt');
        if (jlpt.status === 'idle') loadJlpt();
        else if (jlpt.status === 'ready' && jlptBeyondOn() && !jlpt.beyond && jlpt.beyondStatus !== 'loading') loadBeyond();
        renderJlpt();
    }
    async function loadJlpt() {
        if (jlpt.status === 'loading') return;
        jlpt.status = 'loading'; jlpt.err = null; renderJlpt(); refresh();
        try {
            if (!ContentJ) throw Object.assign(new Error('no adapter'), { bad: true });
            jlpt.words = await ContentJ.loadFile('words');
            jlpt.status = 'ready'; jlpt.all = null;
        } catch (e) {
            console.warn('Endless: JLPT word list failed', e);
            jlpt.status = 'failed'; jlpt.err = e && e.bad ? 'bad' : 'offline';
        }
        renderJlpt(); refresh();
        if (jlpt.status === 'ready' && jlptBeyondOn()) loadBeyond();
    }
    async function loadBeyond() {
        if (jlpt.beyond || jlpt.beyondStatus === 'loading') return !!jlpt.beyond;
        jlpt.beyondStatus = 'loading'; jlpt.beyondErr = null; renderJlpt(); refresh();
        try { jlpt.beyond = await ContentJ.loadFile('beyond'); jlpt.beyondStatus = 'ready'; jlpt.all = null; }
        catch (e) { console.warn('Endless: beyond list failed', e); jlpt.beyondStatus = 'failed'; jlpt.beyondErr = e && e.bad ? 'bad' : 'offline'; }
        renderJlpt(); refresh();
        return !!jlpt.beyond;
    }
    // background prefetch when few N5–N1 words are left (never switches Beyond on)
    function prefetchBeyond() {
        if (jlpt.beyond || jlpt.beyondStatus !== 'idle' || !ContentJ || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        jlpt.beyondStatus = 'prefetch';
        ContentJ.loadFile('beyond').then(b => { jlpt.beyond = b; jlpt.all = null; jlpt.beyondStatus = 'ready'; renderJlpt(); },
                                         () => { jlpt.beyondStatus = 'idle'; });
    }
    function refresh() { if (ctx && phase === 'idle') ctx.updateLiveEstimator(); }
    // ticking Beyond goes through a change event, so app.js saves the setting like any other tick-box
    function setBeyond(on) {
        const cb = $('jlpt-beyond');
        if (!cb || cb.checked === on) { if (on) loadBeyond(); return; }
        cb.checked = on;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    async function addBeyondAndContinue() {
        setBeyond(true);
        const ok = await loadBeyond();
        if (!ok) { alert(OFFLINE_MSG.replace('JLPT word list', 'beyond-JLPT word list')); return; }
        const src = jlptSource();
        if (src) { $('endless-section').classList.add('hidden'); phase = 'idle'; start(src); }
    }
    // The JLPT pool's source, or null when the list isn't loaded or no level is ticked
    function jlptSource() {
        if (jlpt.status !== 'ready') return null;
        const levels = jlptLevels();
        if (!levels.length) return null;
        const beyond = jlptBeyondOn() && !!jlpt.beyond;
        if (beyond && !jlpt.all) jlpt.all = jlpt.words.concat(jlpt.beyond);
        return { kind: 'jlpt', items: beyond ? jlpt.all : jlpt.words, levels, beyond };
    }
    // N1 ticked, Beyond off and every N5–N1 word of the ticked levels started
    function jlptAllStarted() {
        if (jlpt.status !== 'ready' || !meta || jlptBeyondOn()) return false;
        const levels = jlptLevels();
        if (!levels.includes(1)) return false;
        const p = Core.progress(poolItems({ kind: 'jlpt', items: jlpt.words, levels, beyond: false }), states, [], Date.now());
        if (p.notStarted < 50) prefetchBeyond();
        return p.notStarted === 0;
    }
    function renderJlpt() {
        const msg = $('jlpt-load-msg'); if (!msg) return;
        let text = '', retry = false;
        if (jlpt.status === 'idle' || jlpt.status === 'loading') text = 'Loading the word list…';
        else if (jlpt.status === 'failed') { text = jlpt.err === 'bad' ? 'The JLPT word list couldn\'t be read. Try again later.' : OFFLINE_MSG; retry = true; }
        else if (jlptBeyondOn() && jlpt.beyondStatus === 'loading') text = 'Loading the words beyond JLPT…';
        else if (jlptBeyondOn() && jlpt.beyondStatus === 'failed') {
            text = jlpt.beyondErr === 'bad' ? 'The beyond-JLPT word list couldn\'t be read. Try again later.' : OFFLINE_MSG.replace('JLPT word list', 'beyond-JLPT word list');
            retry = true;
        }
        msg.textContent = text;
        msg.classList.toggle('hidden', !text);
        $('jlpt-retry-btn').classList.toggle('hidden', !retry);
        $('jlpt-all-started').classList.toggle('hidden', !jlptAllStarted());
    }
    // app.js: the estimator line and whether Start is enabled on the JLPT tab
    function jlptEstimate() {
        renderJlpt();
        if (jlpt.status !== 'ready') {
            if ($('jlpt-endless-summary')) $('jlpt-endless-summary').textContent = '';
            return { html: jlpt.status === 'failed' ? 'Word list: <span>not downloaded</span>' : 'Loading the word list…', canStart: false };
        }
        const src = jlptSource();
        if (!src) {
            if ($('jlpt-endless-summary')) $('jlpt-endless-summary').textContent = '';
            return { html: 'Tick at least one level', canStart: false };
        }
        return { html: estimateHtml(src), canStart: true };
    }

    // ---------------------------------------------------------------- cloud sync (phase 3)
    // Signed out, nothing here runs apart from renderCloud(): no SDK file is requested until Sign in is tapped
    // or the device was signed in before (localStorage nlCloud = '1'). Progress keeps working without the cloud;
    // a failed sync only shows a note and the unsynced dot.
    const STANDALONE_IOS_MSG = 'Sign-in doesn\'t work inside the home-screen app on some iPhones. Open the site in Safari to sign in; your progress syncs to the home-screen app afterwards.';
    function rememberedSignIn() { try { return localStorage.getItem('nlCloud') === '1'; } catch (_) { return false; } }
    function remember(on) { try { if (on) localStorage.setItem('nlCloud', '1'); else localStorage.removeItem('nlCloud'); } catch (_) { /* */ } }
    function cloudFields() {
        const out = {};
        for (const f of Store.CLOUD_FIELDS) out[f] = JSON.parse(JSON.stringify(meta && meta[f] !== undefined ? meta[f] : null));
        return out;
    }
    // A local change to one item: a state past any tombstone, and the key in the dirty set (only once this
    // device syncs: a device that never synced uploads everything at its first sign-in). -> meta patch
    function touched(key, state) {
        if (!meta || !meta.uid) return {};
        const patch = {};
        const tomb = meta.tombs && meta.tombs[key];
        if (tomb) {
            if (state && (state.rev || 0) <= tomb.rev) state.rev = tomb.rev + 1;
            patch.tombs = Object.assign({}, meta.tombs); delete patch.tombs[key];
        }
        if (!meta.dirty.includes(key)) patch.dirty = meta.dirty.concat([key]);
        return patch;
    }
    function localView() {
        // copies: answers given while a sync runs must not change what it works on
        return { states: Object.assign({}, states), tombs: Object.assign({}, meta.tombs), dirty: (meta.dirty || []).slice(), epoch: meta.epoch || 0, lastSeenCm: meta.lastSeenCm || [],
                 W: meta.W, baseline: meta.baseline || [], wbMt: meta.wbMt || 0, pendingReset: !!meta.pendingReset,
                 forceUpload: !!meta.forceUpload, deviceId: meta.deviceId };
    }
    function isStandaloneIOS() {
        const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
        return !!(ios && standalone);
    }
    function ago(t) {
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        if (s < 45) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 60);
        return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
    }

    function renderCloud() {
        const line = $('endless-cloud-line'); if (!line) return;
        const inBtn = $('endless-signin-btn'), outBtn = $('endless-signout-btn'), delBtn = $('endless-delete-cloud-btn');
        const priv = $('endless-cloud-privacy');
        const on = !!cloud.user;
        inBtn.classList.toggle('hidden', on);
        outBtn.classList.toggle('hidden', !on);
        delBtn.classList.toggle('hidden', !on);
        priv.classList.toggle('hidden', !on);
        let text;
        if (!on) text = cloud.note || 'Cloud sync: Sign in with Google to use your progress on other devices';
        else {
            const who = 'Signed in as ' + (cloud.user.email || 'your Google account');
            const st = cloud.status === 'syncing' ? 'syncing…'
                : cloud.status === 'quota' ? 'cloud sync is paused until tomorrow (free daily limit). Your progress is safe on this device.'
                : cloud.status === 'offline' ? 'offline — will sync later'
                : cloud.lastSyncAt ? 'synced ' + ago(cloud.lastSyncAt) : 'not synced yet';
            text = who + ' · ' + st + (cloud.note ? ' · ' + cloud.note : '');
        }
        line.textContent = text;
        const dot = $('endless-unsynced');
        if (dot) dot.classList.toggle('hidden', !(on && cloud.failed));
    }
    function cloudNote(text) { cloud.note = text || ''; renderCloud(); }

    async function signIn() {
        if (!Cloud || !Cloud.configured()) { cloudNote('Cloud sync isn\'t set up yet'); return; }
        cloudNote('Signing in…');
        let user;
        try { user = await Cloud.signIn(); }
        catch (e) {
            console.warn('Endless: sign-in failed', e);
            const code = e && e.code || '';
            if (isStandaloneIOS() && /popup|operation-not-supported|web-storage/.test(code + ' ' + (e && e.message || ''))) cloudNote(STANDALONE_IOS_MSG);
            else if (/popup-closed|cancelled-popup/.test(code)) cloudNote('');
            else cloudNote('Sign-in failed: ' + (e && e.message || e));
            return;
        }
        if (!user) { cloudNote(''); return; }
        await userArrived(user, true);
    }

    // At start-up for a device that was signed in: the SDK restores the session.
    function startCloud() {
        if (!Cloud || !Cloud.configured() || cloud.started) return;
        cloud.started = true;
        Promise.resolve(Cloud.onUser(u => {
            if (u && (!cloud.user || cloud.user.uid !== u.uid)) userArrived(u, false);
            else if (!u && cloud.user) { cloud.user = null; cloud.status = 'off'; renderCloud(); }
        })).catch(e => { console.warn('Endless: cloud start failed', e); cloud.started = false; cloudNote('offline — will sync later'); });
    }

    // A Google account is signed in (tap, or restored). Account binding first: never merge two accounts silently.
    async function userArrived(user, tapped) {
        await storeReady;
        if (!meta) return;
        const bind = Sync.bindCheck(meta.uid, user.uid);
        if (bind === 'other') {
            const replace = confirm('This device has progress from another Google account. Replace it with this account\'s progress?\n\n' +
                                    'OK = replace it with this account\'s progress. Cancel = keep it on this device and don\'t sync.');
            if (!replace) { await signOut('Not syncing: this device keeps the other account\'s progress.'); return; }
            await store.reset();
            await store.saveMeta({ uid: user.uid, cloudEmail: user.email || '' });
            await reload();
        } else if (bind === 'first') {
            // progress made before the first sign-in goes up (merged as usual)
            const all = [...new Set([...Object.keys(states), ...(meta.dirty || [])])];
            Object.assign(meta, { uid: user.uid, cloudEmail: user.email || '', dirty: all });
            await store.saveMeta({ uid: meta.uid, cloudEmail: meta.cloudEmail, dirty: meta.dirty });
        } else if (meta.cloudEmail !== (user.email || '')) {
            meta.cloudEmail = user.email || ''; await store.saveMeta({ cloudEmail: meta.cloudEmail });
        }
        cloud.user = user;
        cloud.started = true;
        remember(true);
        cloud.note = '';
        renderCloud();
        if (meta.cloudWiped) {
            // this account's cloud copy was deleted earlier (here or on another device)
            if (!confirm('Your Endless cloud data was deleted earlier. Start syncing again from this device?')) {
                await signOut('Not syncing: the cloud copy was deleted.'); return;
            }
            meta.cloudWiped = false; meta.forceUpload = true;
            await store.saveMeta({ cloudWiped: false, forceUpload: true });
        }
        await doSync(tapped ? 'signin' : 'load');
    }

    async function signOut(note) {
        cloud.user = null; cloud.status = 'off'; cloud.failed = false; cloud.started = false;
        remember(false);
        try { if (Cloud) await Cloud.signOut(); } catch (e) { console.warn('Endless: sign-out failed', e); }
        cloudNote(note || '');
    }

    async function deleteCloudData() {
        if (!cloud.user) return;
        if (!confirm('Delete your Endless progress from the cloud? It stays on this device.')) return;
        cloudNote('Deleting…');
        try {
            await waitIdle();
            const r = await Sync.deleteCloud(Cloud.adapter(cloud.user.uid), localView(), Date.now());
            Object.assign(meta, { epoch: r.epoch, cloudWiped: true, dirty: [], tombs: {}, lastSeenCm: [], forceUpload: false, pendingReset: false });
            await store.saveMeta({ epoch: r.epoch, cloudWiped: true, dirty: [], tombs: {}, lastSeenCm: [], forceUpload: false, pendingReset: false });
            await signOut('Your cloud data was deleted. Progress stays on this device.');
        } catch (e) { syncFailed(e); }
    }

    function maybeSync(reason) {
        if (!cloud.user || !meta || !meta.uid) return;
        const st = { dirtyCount: (meta.dirty || []).length + (meta.pendingReset ? 1 : 0) + (meta.forceUpload ? 1 : 0),
                     lastSyncAt: cloud.lastSyncAt, answersSinceSync: cloud.answersSinceSync, pausedUntil: cloud.pausedUntil };
        if (!Sync.shouldSync(reason, st, Date.now())) return;
        doSync(reason).catch(e => console.warn('Endless: sync failed', e));
    }
    async function waitIdle() { while (cloud.running) { try { await cloud.running; } catch (_) { /* */ } } }

    // One sync: a transaction in srs_sync.js, then its result written into the local store in one write.
    function doSync(reason) {
        if (cloud.running) {                                     // one at a time; a request while one runs follows it
            if (!cloud.again) cloud.again = cloud.running.then(() => { cloud.again = null; return doSync(reason); }, () => { cloud.again = null; });
            return cloud.again;
        }
        let followLoad = false;
        cloud.running = (async () => {
            if (!cloud.user) return;
            if (cloud.pausedUntil && Date.now() < cloud.pausedUntil) { cloud.status = 'quota'; renderCloud(); return; }
            cloud.status = 'syncing'; renderCloud();
            const L = localView();
            const startRevs = Sync.revsOf(L);
            const answersAtStart = cloud.answersSinceSync;
            const now = Date.now();
            let res;
            try { res = await Sync.sync(Cloud.adapter(cloud.user.uid), L, now); }
            catch (e) { syncFailed(e); return; }
            cloud.syncs++;
            if (res.status === 'reset') {
                // Reset (or an import) on another device: adopt it, then load the cloud copy
                const keep = cloudFields();
                await store.reset();
                await store.saveMeta(Object.assign(keep, { epoch: res.epoch, lastSeenCm: Sync.zeros(), dirty: [], tombs: {}, pendingReset: false }));
                await reload();
                cloud.note = 'Progress was reset on another device.';
                followLoad = true;
                return;
            }
            if (res.status === 'wiped') {
                meta.cloudWiped = true; meta.epoch = res.epoch;
                await store.saveMeta({ cloudWiped: true, epoch: res.epoch });
                await signOut('Cloud data was deleted from another device. Progress stays on this device.');
                return;
            }
            // a cloud win goes into the local states, except for items changed again while the sync ran
            // (they stay dirty and go up next time)
            for (const k of Object.keys(res.localUpdates || {})) {
                if (states[k] !== L.states[k] || JSON.stringify((meta.tombs || {})[k]) !== JSON.stringify(L.tombs[k])) delete res.localUpdates[k];
            }
            const view = { states: Object.assign({}, states), tombs: Object.assign({}, meta.tombs), dirty: (meta.dirty || []).slice(),
                           epoch: meta.epoch, lastSeenCm: meta.lastSeenCm, W: meta.W, baseline: meta.baseline, wbMt: meta.wbMt,
                           pendingReset: meta.pendingReset, forceUpload: meta.forceUpload };
            Sync.applyResult(view, res, startRevs);
            const put = {}, del = [];
            for (const k of view.changedKeys) {
                if (view.states[k]) { put[k] = view.states[k]; states[k] = view.states[k]; }
                else { del.push(k); delete states[k]; }
            }
            const metaPatch = { tombs: view.tombs, dirty: view.dirty, epoch: view.epoch, lastSeenCm: view.lastSeenCm,
                                pendingReset: res.resetPushed ? false : !!meta.pendingReset, forceUpload: false };
            if (res.meta) Object.assign(metaPatch, { W: view.W, baseline: view.baseline, wbMt: view.wbMt });
            Object.assign(meta, metaPatch);
            await store.applyCloud({ put, del, metaPatch });
            cloud.lastSyncAt = Date.now();
            cloud.answersSinceSync = Math.max(0, cloud.answersSinceSync - answersAtStart);
            cloud.failed = false; cloud.status = 'ok';
            if (reason !== 'load') cloud.note = '';
            renderCloud();
            if (view.changedKeys.length && phase === 'idle') ctx.updateLiveEstimator();
        })().finally(() => { cloud.running = null; if (followLoad) doSync('load').catch(e => console.warn('Endless: sync failed', e)); });
        return cloud.running;
    }
    function syncFailed(e) {
        console.warn('Endless: sync failed', e);
        cloud.failed = true;
        const code = String(e && e.code || '');
        if (/resource-exhausted/.test(code)) { cloud.pausedUntil = Sync.nextPacificMidnight(Date.now()); cloud.status = 'quota'; }
        else cloud.status = 'offline';
        renderCloud();
    }

    // For tests
    function _state() { return { kind: srcKind, promptA, sib: pick && pick.sib ? { kind: pick.sib.kind, count: pick.sib.count, here: pick.sib.here } : null, jlpt: { status: jlpt.status, words: jlpt.words ? jlpt.words.length : 0, beyond: jlpt.beyond ? jlpt.beyond.length : 0, beyondStatus: jlpt.beyondStatus },
                              meta, states, log, sess, pick, phase, items: items.length, backend: store && store.backend.kind, warnings, shownAt, paused, last: last && { cls: last.cls, kana: last.kana, answeredAt: last.answeredAt },
                              cloud: { user: cloud.user, status: cloud.status, lastSyncAt: cloud.lastSyncAt, answersSinceSync: cloud.answersSinceSync,
                                       pausedUntil: cloud.pausedUntil, failed: cloud.failed, note: cloud.note, syncs: cloud.syncs } }; }
    async function _seed(newStates) {          // tests: replace the stored states
        for (const [k, s] of Object.entries(newStates)) { states[k] = s; await store.saveAnswer({ key: k, state: s }); }
    }

    return { init, start, estimateHtml, recordExternal, attachShared, jlptShown, jlptSource, jlptEstimate, _state, _seed, ready: () => storeReady,
             _queue: () => externalQueue.length, _sync: reason => (reason ? doSync(reason) : waitIdle()), _maybeSync: maybeSync, _cloud: () => cloud };
})();
