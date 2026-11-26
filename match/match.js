// Kanji Match: page UI (Home, Board, Summary). Game rules live in match_core.js,
// saving in match_store.js. Nothing about boxes or review scheduling is shown during play.
(function () {
    'use strict';

    const C = window.MatchCore, S = window.MatchStore, Y = window.MatchSync, CLOUD = window.MatchCloud;
    const APP_VERSION = '1.5';
    const DECKS = {
        'kanji-meaning': { files: 'levels', front: 'kanji', back: 'meaning', items: ['kanji', 'kanji'] },
        'word-reading': { files: 'words', front: 'word', back: 'reading', items: ['word', 'words'] },
        // R6 deck B: the word with one kanji highlighted ↔ its reading with that kanji's part marked
        'word-kanji': { files: 'words', front: 'word', back: 'reading', items: ['word', 'words'], build: C.kanjiCards },
    };
    const isWordDeck = d => d === 'word-reading' || d === 'word-kanji';
    const LEVEL_NAMES = { N5: 'N5', N4: 'N4', N3: 'N3', N2: 'N2', N1: 'N1', X: 'Extras' };
    const DEFAULTS = { deck: 'kanji-meaning', level: 'N5', includeEasier: false, keepGoing: true, played: null, size: 12, showTimer: true, vibrate: true, wholeWord: false,
                       iosTipDismissed: false, persistAsked: false };
    const params = new URLSearchParams(location.search);
    const TEST_SEED = params.has('seed') ? Number(params.get('seed')) : null;
    const $ = id => document.getElementById(id);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    const app = {
        meta: null, synIdx: null, levels: { 'kanji-meaning': {}, 'word-reading': {}, 'word-kanji': {} }, byId: new Map(),
        span: [], inPlay: { levels: [], added: [] }, pool: [], reviewPool: [],
        store: null, saved: null, settings: Object.assign({}, DEFAULTS),
        recent: [], board: null, boardCount: 0, timer: null, lastShown: null,
        sync: null, syncPending: false,
    };
    if (params.has('test')) window.__match = app;

    // ------------------------------------------------------------------ helpers
    const deck = () => DECKS[app.settings.deck] ? app.settings.deck : 'kanji-meaning';
    const D = () => DECKS[deck()];
    const isWord = it => it.id.startsWith('w:') || it.id.startsWith('h:');
    // Words: deck B (one kanji highlighted) unless "Whole word" is on (deck C)
    const wordDeck = () => (app.settings.wholeWord ? 'word-reading' : 'word-kanji');
    // A span with part of the text marked (deck B: the target kanji / its part of the reading).
    function marked(cls, text, range, ja) {
        const s = el('span', cls); if (ja) s.lang = 'ja';
        if (!range) { s.textContent = text; return s; }
        s.append(document.createTextNode(text.slice(0, range[0])), el('mark', 'hl', text.slice(range[0], range[1])),
                 document.createTextNode(text.slice(range[1])));
        return s;
    }
    const items = () => app.saved.items[deck()] || (app.saved.items[deck()] = {});
    const confusions = () => app.saved.confusions[deck()] || (app.saved.confusions[deck()] = {});
    const nItems = n => plural(n, D().items[0], D().items[1]);
    const today = () => C.studyDay(Date.now());
    const fmtTime = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
    const glossText = it => it.gloss + (it.gloss2 ? ', ' + it.gloss2 : '');
    const backText = it => isWord(it) ? it.r : glossText(it);
    const playingText = () => app.inPlay.levels.length ? C.playingLabel(app.inPlay, LEVEL_NAMES) : LEVEL_NAMES[app.settings.level];
    const choiceName = () => (isWordDeck(deck()) ? 'Words ' : '') + playingText();
    // PC keyboard layout (decision 9): both sides the same grid, key letters on the cards.
    const KEY_LAYOUT = '(hover: hover) and (pointer: fine) and (min-width: 700px)';
    // Off since R4 (Zachary 11/26: harder to know which key to press than expected). true turns it back on.
    const KEY_PLAY = false;
    const keyLayout = () => KEY_PLAY && window.matchMedia(KEY_LAYOUT).matches;
    const played = () => (app.settings.played && app.settings.played[deck()]) || [];

    function showWarning(text) {
        const w = $('home-warning');
        w.textContent = text; w.classList.toggle('hidden', !text);
    }

    async function loadLevels(levels) {
        const cache = app.levels[deck()], files = app.meta[D().files];
        const need = levels.filter(lv => !cache[lv] && files[lv]);
        await Promise.all(need.map(async lv => {
            const info = files[lv];
            const res = await fetch(`data/${info.file}?b=${app.meta.build}`);
            if (!res.ok) throw new Error(`Couldn't load ${info.file} (${res.status})`);
            const doc = await res.json();
            cache[lv] = D().build ? D().build(doc.items) : doc.items;
            cache[lv].forEach(it => app.byId.set(it.id, it));
        }));
        return levels.flatMap(lv => cache[lv] || []);
    }

    // Works out the levels in play (decision 5) and loads them, plus every played level (for Review).
    // Sets app.inPlay, app.span (levels in play), app.pool (Play) and app.reviewPool (Review).
    async function planPool() {
        const st = items(), cache = app.levels[deck()];
        let r;
        for (;;) {
            r = C.levelsInPlay({ level: app.settings.level, includeEasier: app.settings.includeEasier,
                                 keepGoing: app.settings.keepGoing, levels: cache, states: st });
            if (!r.need) break;
            if (!app.meta[D().files][r.need]) { r = { levels: r.levels.filter(lv => cache[lv]), added: r.added, need: null }; break; }
            await loadLevels([r.need]);
        }
        await loadLevels(played());
        app.inPlay = r; app.span = r.levels.slice();
        app.pool = C.poolFor({ inPlay: r.levels, played: played(), levels: cache, states: st });
        app.reviewPool = C.poolFor({ inPlay: r.levels, played: played(), levels: cache, states: st, review: true });
        return app.pool;
    }
    function notePlayed(levels) {
        const p = app.settings.played || (app.settings.played = {});
        const list = p[deck()] || (p[deck()] = []);
        levels.forEach(lv => { if (!list.includes(lv)) list.push(lv); });
        list.sort((a, b) => C.LEVEL_ORDER.indexOf(a) - C.LEVEL_ORDER.indexOf(b));
        saveSettings();
    }
    const loadRecent = () => {
        app.recent = (app.saved.log || []).filter(r => r.deck === deck()).slice(-3).reverse().map(r => r.items.map(i => i.id));
    };

    // ------------------------------------------------------------------ start-up
    async function init() {
        try {
            app.store = S.local();
            app.saved = await app.store.load();
        } catch (e) {
            app.store = S.memory();
            app.saved = await app.store.load();
            showWarning("This browser won't let the page save progress (private mode?). You can play, but nothing will be kept.");
        }
        Object.assign(app.settings, app.saved.settings || {});
        migrateSettings();
        if (app.saved.warnings && app.saved.warnings.length) showWarning(app.saved.warnings.join(' '));
        // Levels with progress: kept in settings; v1 progress is found from the board log.
        if (!app.settings.played) derivePlayed();
        // Last boards from the log, so spacing still works after a reload.
        loadRecent();

        const res = await fetch(`data/meta.json?v=${APP_VERSION}`, { cache: 'no-cache' });
        app.meta = await res.json();
        app.synIdx = C.synonymIndex(app.meta.synonyms);

        applySettingsToForm();
        bindHome();
        bindBoard();
        await renderHome();

        if (!app.settings.persistAsked && navigator.storage && navigator.storage.persist) {
            app.settings.persistAsked = true; saveSettings();
            navigator.storage.persist().catch(() => {});
        }
        startSync();
    }

    // ------------------------------------------------------------------ sign-in and sync (R5)
    function startSync() {
        if (!Y || !CLOUD) { $('account').classList.add('hidden'); return; }
        app.sync = Y.controller({ cloud: CLOUD, store: app.store, onStatus: renderAccount, onApplied: syncApplied, guard: accountGuard() });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') app.sync.hidden(); });
        window.addEventListener('pagehide', () => app.sync.hidden());
        window.addEventListener('online', () => app.sync.online());
        app.sync.start();
    }
    // Decision 14: a different account than the last one on this browser, with progress here: ask first.
    const LAST_UID = 'nihongoMatch.lastUid';         // outside the progress prefix, so Reset keeps it
    function accountGuard() {
        return {
            lastUid: () => { try { return localStorage.getItem(LAST_UID); } catch (e) { return null; } },
            setLastUid: uid => { try { localStorage.setItem(LAST_UID, uid); } catch (e) { /* private mode */ } },
            hasLocal: async () => {
                const s = await app.store.load();
                return Object.values(s.items).some(m => Object.keys(m || {}).length > 0) || (s.log || []).length > 0;
            },
            ask: u => new Promise(resolve => {
                const box = $('account-confirm'); box.textContent = '';
                box.appendChild(el('p', null, `${u.email || 'This account'} is not the account last used on this browser, and this browser has Kanji Match progress.`));
                const row = el('div', 'row');
                [['merge', "Add this browser's progress to this account", 'btn small primary'],
                 ['replace', "Use only this account's progress (this browser's progress is saved as a backup file first)", 'btn small'],
                 ['cancel', 'Cancel and sign out', 'btn small']].forEach(([v, text, cls]) => {
                    const b = el('button', cls, text); b.type = 'button';
                    b.addEventListener('click', () => { box.classList.add('hidden'); box.textContent = ''; resolve(v); });
                    row.appendChild(b);
                });
                box.appendChild(row); box.classList.remove('hidden');
            }),
            replaceLocal: async () => {
                await exportProgress();
                const st = (await app.store.load()).settings || {};
                await app.store.reset({ keepMeta: true });
                // the account's settings win at the next sync (upd 0); device-only ones stay
                await app.store.saveSettings({ persistAsked: !!st.persistAsked, iosTipDismissed: !!st.iosTipDismissed, upd: 0 });
                await reloadSaved();
            },
        };
    }
    // Merged progress from the cloud was saved: show it (after the board, if one is being played).
    async function syncApplied() {
        if (app.board && !app.board.done) { app.syncPending = true; return; }
        await reloadSaved();
    }
    async function reloadSaved() {
        app.syncPending = false;
        app.saved = await app.store.load();
        Object.assign(app.settings, DEFAULTS, app.saved.settings || {});
        migrateSettings();
        if (!app.settings.played) derivePlayed();
        loadRecent();
        applySettingsToForm();
        if (!$('home').classList.contains('hidden')) renderHome();
    }
    function renderAccount(st) {
        const btn = $('signin-btn'), out = $('signout-btn'), line = $('account-status'), hint = $('account-hint');
        const signedIn = !!st.user && st.state !== 'signed-out';
        btn.classList.toggle('hidden', signedIn);
        btn.disabled = st.state === 'loading';
        btn.textContent = st.state === 'loading' ? 'Signing in…' : 'Sign in to keep your progress';
        out.classList.toggle('hidden', !signedIn);
        line.classList.toggle('hidden', !signedIn);
        line.textContent = '';
        if (signedIn) {
            line.appendChild(el('span', 'who', st.user.email || 'Signed in'));
            const at = st.at ? new Date(st.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const what = { syncing: 'Syncing…', synced: 'Synced · ' + at, offline: 'Offline, will retry',
                           error: "Couldn't sync", loading: 'Signing in…', confirm: 'Choose below' }[st.state] || '';
            line.appendChild(document.createTextNode(' · ' + what));
        }
        hint.textContent = st.message || (signedIn ? '' : 'Google sign-in, the same as Endless. Your progress then follows you to other devices.');
        hint.classList.toggle('error', st.state === 'error');
    }

    // v1/R3 settings: size 8 → 12 (decision 8); v1 "include lower levels" → Include easier levels.
    function migrateSettings() {
        const st = app.settings;
        st.size = C.normSize(st.size);
        const saved = (app.saved && app.saved.settings) || {};
        if (typeof saved.includeEasier !== 'boolean' && 'includeLower' in saved) st.includeEasier = !!saved.includeLower;
        if (typeof st.includeEasier !== 'boolean') st.includeEasier = false;
        delete st.includeLower;
        if (typeof st.keepGoing !== 'boolean') st.keepGoing = true;
        // R6: Words now means deck B by default; a saved Words choice (deck C) moves to deck B once.
        if (typeof st.wholeWord !== 'boolean') { st.wholeWord = false; if (st.deck === 'word-reading') st.deck = 'word-kanji'; }
        // R5: settings saved before sync count as chosen long ago (1), a fresh browser's defaults as never (0).
        if (typeof st.upd !== 'number') st.upd = Object.keys(saved).some(k => !['persistAsked', 'iosTipDismissed', 'played'].includes(k)) ? 1 : 0;
    }

    function derivePlayed() {
        app.settings.played = {};
        (app.saved.log || []).forEach(r => (r.levels || [r.level]).forEach(lv => {
            const l = app.settings.played[r.deck] || (app.settings.played[r.deck] = []);
            if (lv && !l.includes(lv)) l.push(lv);
        }));
    }

    function saveSettings() { app.store.saveSettings(app.settings).catch(() => {}); }
    // A change the user made: newest settings win when two devices sync (decision 10).
    function touchSettings() {
        app.settings.upd = Date.now(); delete app.settings.by;
        saveSettings();
        if (app.sync) app.sync.settingsChanged();
    }

    function applySettingsToForm() {
        const f = $('setup');
        f.querySelector(`input[name="level"][value="${app.settings.level}"]`).checked = true;
        const dk = f.querySelector(`input[name="deck"][value="${isWordDeck(deck()) ? 'words' : deck()}"]`);
        if (dk) dk.checked = true;
        $('whole-word').checked = !!app.settings.wholeWord;
        $('whole-word-row').classList.toggle('hidden', !isWordDeck(deck()));
        const size = f.querySelector(`input[name="size"][value="${app.settings.size}"]`);
        if (size) size.checked = true;
        $('include-easier').checked = !!app.settings.includeEasier;
        $('keep-going').checked = !!app.settings.keepGoing;
        $('opt-timer').checked = !!app.settings.showTimer;
        $('opt-vibrate').checked = !!app.settings.vibrate;
    }

    // ------------------------------------------------------------------ home
    function bindHome() {
        const f = $('setup');
        f.addEventListener('change', e => {
            if (e.target.name === 'level') app.settings.level = e.target.value;
            if (e.target.name === 'size') app.settings.size = C.normSize(e.target.value);
            if (e.target.name === 'deck') { app.settings.deck = e.target.value === 'words' ? wordDeck() : e.target.value; loadRecent(); }
            if (e.target.id === 'whole-word') {
                app.settings.wholeWord = e.target.checked;
                if (isWordDeck(deck())) { app.settings.deck = wordDeck(); loadRecent(); }
            }
            $('whole-word-row').classList.toggle('hidden', !isWordDeck(deck()));
            if (e.target.id === 'keep-going') app.settings.keepGoing = e.target.checked;
            if (e.target.id === 'include-easier') app.settings.includeEasier = e.target.checked;
            touchSettings(); renderHome();
        });
        f.addEventListener('submit', e => { e.preventDefault(); startBoard('play'); });
        $('review-btn').addEventListener('click', () => startBoard('review'));
        $('next-level-btn').addEventListener('click', () => {
            const nx = C.nextLevel(app.settings.level); if (!nx) return;
            app.settings.level = nx; applySettingsToForm(); touchSettings(); renderHome();
        });
        $('opt-timer').addEventListener('change', e => { app.settings.showTimer = e.target.checked; touchSettings(); });
        $('opt-vibrate').addEventListener('change', e => { app.settings.vibrate = e.target.checked; touchSettings(); });
        $('export-btn').addEventListener('click', exportProgress);
        $('import-file').addEventListener('change', importProgress);
        $('reset-btn').addEventListener('click', confirmReset);
        $('ios-tip-close').addEventListener('click', () => { app.settings.iosTipDismissed = true; saveSettings(); $('ios-tip').classList.add('hidden'); });
        $('signin-btn').addEventListener('click', () => app.sync && app.sync.signIn());
        $('signout-btn').addEventListener('click', () => app.sync && app.sync.signOut());
    }

    async function renderHome() {
        $('extras-hint').classList.toggle('hidden', app.settings.level !== 'X');
        let pool;
        try { pool = await planPool(); } catch (e) { showWarning(e.message); return; }
        const st = items(), day = today(), cache = app.levels[deck()];

        // level chips: seen / total (unloaded levels have nothing seen)
        const files = app.meta[D().files];
        document.querySelectorAll('#level-choice input').forEach(inp => {
            const lv = inp.value, total = files[lv] ? files[lv].count : 0;
            const seen = cache[lv] ? cache[lv].filter(it => st[it.id]).length : 0;
            let c = inp.parentElement.querySelector('small');
            if (!c) { c = el('small', 'lv-seen'); inp.nextElementSibling.appendChild(c); }
            c.textContent = ` ${seen}/${total}`;
        });
        const nx = C.nextLevel(app.settings.level);
        const doneHere = C.fullySeen(cache[app.settings.level] || [], st);
        const nb = $('next-level-btn');
        nb.classList.toggle('hidden', !(nx && doneHere));
        if (nx) nb.textContent = `Start ${LEVEL_NAMES[nx]}`;
        $('playing-line').textContent = `Playing: ${playingText()}`;
        const add = app.inPlay.added;
        $('keep-hint').textContent = add.length
            ? `${LEVEL_NAMES[app.settings.level]} is fully seen, so new ${D().items[1]} now come from ${LEVEL_NAMES[add[add.length - 1]]}.`
            : '';

        // progress bars
        const bars = $('progress-bars'); bars.textContent = '';
        const shownLevels = C.LEVEL_ORDER.filter(lv => cache[lv] && (app.span.includes(lv) || played().includes(lv)));
        for (const lv of shownLevels) {
            const counts = { strong: 0, learning: 0, weak: 0, unseen: 0 };
            cache[lv].forEach(it => { counts[C.band(st[it.id])]++; });
            const total = cache[lv].length;
            const row = el('div', 'lv-row');
            row.appendChild(el('span', 'lv-name', LEVEL_NAMES[lv]));
            const bar = el('div', 'lv-bar');
            bar.setAttribute('role', 'img');
            bar.setAttribute('aria-label', `${LEVEL_NAMES[lv]}: ${counts.strong} strong, ${counts.learning} learning, ${counts.weak} need work, ${counts.unseen} not seen yet, of ${total}`);
            ['strong', 'learning', 'weak'].forEach(b => {
                if (!counts[b]) return;
                const s = el('span', b); s.style.width = (100 * counts[b] / total) + '%'; bar.appendChild(s);
            });
            row.appendChild(bar);
            row.appendChild(el('span', 'lv-count',
                `${counts.strong} strong, ${counts.learning} learning, ${counts.weak} need work, ${counts.unseen} not seen yet`));
            bars.appendChild(row);
        }

        // review availability
        const rpool = app.reviewPool;
        const due = rpool.filter(it => st[it.id] && (st[it.id].box === 1 || st[it.id].due <= day)).length;
        const rb = $('review-btn');
        rb.textContent = due ? `Review (${due})` : 'Review';
        rb.disabled = !due;
        let hint = '';
        if (!due) {
            const future = rpool.map(it => st[it.id]).filter(Boolean).map(s => s.due).filter(d => d > day).sort();
            if (future.length) {
                const next = future[0], n = future.filter(d => d === next).length;
                const when = C.dayDiff(day, next) === 1 ? 'tomorrow' : `on ${next}`;
                hint = `Nothing to review right now. ${nItems(n)} come back ${when}.`;
            } else if (!rpool.some(it => st[it.id])) {
                hint = 'Review opens once you have played a board.';
            }
        }
        $('review-hint').textContent = hint;

        // facts: boards today, streak, best for this choice
        const days = app.saved.days || {};
        let d = day, streak = 0;
        if (!(days[d] && days[d].boards)) d = C.addDays(d, -1);
        while (days[d] && days[d].boards) { streak++; d = C.addDays(d, -1); }
        const best = app.saved.bests[C.bestKey(deck(), app.settings.level, app.settings.includeEasier, app.settings.size)];
        const facts = [];
        facts.push(`Boards today: ${(days[day] && days[day].boards) || 0}.`);
        if (streak) facts.push(`Study streak: ${plural(streak, 'day')}.`);
        if (best) facts.push(`Best for ${choiceName()}, ${app.settings.size} pairs: ${plural(best.misses, 'wrong pair')} in ${fmtTime(best.activeMs)}.`);
        $('progress-facts').textContent = facts.join(' ');

        // kanji that keep slipping
        const trouble = pool.filter(it => C.isTrouble(st[it.id]));
        $('trouble').classList.toggle('hidden', !trouble.length);
        $('trouble-count').textContent = trouble.length;
        $('trouble-what').textContent = D().items[1];
        const tl = $('trouble-list'); tl.textContent = '';
        trouble.forEach(it => {
            const c = el('span', 'chip');
            c.append(marked('k', it.k, it.hk, true), marked('m', backText(it), it.hr, isWord(it)));
            tl.appendChild(c);
        });

        // backup status and reminder
        const m = app.saved.meta;
        const since = m.boardsSinceExport || 0;
        $('backup-status').textContent = m.lastExportAt
            ? `Last export: ${new Date(m.lastExportAt).toLocaleDateString()} (${plural(since, 'board')} since).`
            : (since ? `Not exported yet (${plural(since, 'board')} played).` : 'Your progress is saved in this browser only.');
        const stale = !m.lastExportAt || Date.now() - m.lastExportAt > 14 * 86400000;
        if (since >= 20 && stale && $('home-warning').classList.contains('hidden')) {
            showWarning('Your progress lives only in this browser. Export a backup from Options and backup.');
        }

        const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
        $('ios-tip').classList.toggle('hidden', !(ios && !standalone && !app.settings.iosTipDismissed));
    }

    // ------------------------------------------------------------------ backup
    async function exportProgress() {
        const data = await app.store.exportAll();
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const a = el('a'); a.href = URL.createObjectURL(blob);
        a.download = `nihongo-match-${today()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        await app.store.saveMeta({ lastExportAt: Date.now(), boardsSinceExport: 0 });
        app.saved = await app.store.load();
        showWarning('');
        renderHome();
    }

    function confirmBox(contents) {
        const box = $('backup-confirm');
        box.textContent = ''; contents.forEach(c => box.appendChild(c));
        box.classList.remove('hidden');
        return box;
    }
    const closeConfirm = () => $('backup-confirm').classList.add('hidden');

    async function importProgress(e) {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        let obj, sum;
        try { obj = JSON.parse(await file.text()); sum = app.store.summary(obj); } catch (err) {
            confirmBox([el('p', null, err instanceof SyntaxError ? "This file isn't a Kanji Match backup." : err.message)]);
            return;
        }
        const yes = el('button', 'btn primary small', 'Replace my progress');
        const no = el('button', 'btn small', 'Cancel');
        yes.type = no.type = 'button';
        const when = sum.exportedAt ? new Date(sum.exportedAt).toLocaleString() : 'an unknown date';
        confirmBox([el('p', null, `This backup has progress on ${plural(sum.items, 'card')} and ${plural(sum.boards, 'board')}, exported ${when}. Importing replaces the progress in this browser.`), yes, no]);
        no.onclick = closeConfirm;
        yes.onclick = async () => {
            await app.store.importAll(obj);
            app.saved = await app.store.load();
            Object.assign(app.settings, DEFAULTS, app.saved.settings || {});
            migrateSettings();
            if (!app.settings.played) derivePlayed();
            loadRecent();
            applySettingsToForm(); closeConfirm(); showWarning('Backup imported.'); renderHome();
            if (app.sync) app.sync.boardDone();
        };
    }

    function confirmReset() {
        const input = el('input'); input.type = 'text'; input.setAttribute('aria-label', 'Type reset to confirm');
        const yes = el('button', 'btn small danger-quiet', 'Reset progress');
        const no = el('button', 'btn small', 'Cancel');
        yes.type = no.type = 'button'; yes.disabled = true;
        input.oninput = () => { yes.disabled = input.value.trim().toLowerCase() !== 'reset'; };
        const cloudNote = app.sync && app.sync.user() ? " You're signed in: the copy in the cloud is kept, and comes back here at the next sync." : '';
        confirmBox([el('p', null, 'This deletes all progress, bests and history in this browser.' + cloudNote + ' Export a backup first if you might want it back. Type "reset" to confirm.'), input, yes, no]);
        input.focus();
        no.onclick = closeConfirm;
        yes.onclick = async () => {
            await app.store.reset();
            app.saved = await app.store.load();
            app.recent = [];
            await app.store.saveSettings(app.settings);
            closeConfirm(); showWarning('Progress reset.'); renderHome();
        };
    }

    // ------------------------------------------------------------------ board
    // Side-by-side board (match.css): wide screens and landscape. R6: portrait tablets below 900 px stack, like phones.
    const WIDE_LAYOUT = '(min-width: 900px), (orientation: landscape) and (min-width: 560px)';
    const SHORT_LANDSCAPE = '(orientation: landscape) and (max-height: 500px) and (min-width: 560px)';
    function gridFor(n) {
        if (keyLayout()) { const c = C.keyCols(n), r = Math.ceil(n / c); return { kc: c, kr: r, ac: c, ar: r }; }
        const kc = n <= 6 ? 3 : 4;
        const ac = (n <= 8 || window.matchMedia(SHORT_LANDSCAPE).matches) ? 2 : 3;
        return { kc, kr: Math.ceil(n / kc), ac, ar: Math.ceil(n / ac) };
    }

    async function startBoard(mode) {
        let pool;
        if (app.syncPending) await reloadSaved();
        try { await planPool(); } catch (e) { showWarning(e.message); return; }
        pool = mode === 'review' ? app.reviewPool : app.pool;
        const seed = TEST_SEED !== null ? TEST_SEED + app.boardCount : ((Date.now() ^ (Math.random() * 4294967296)) >>> 0);
        const b = C.buildBoard({ pool, states: items(), confusions: confusions(), size: app.settings.size, mode,
                                 recent: app.recent, today: today(), seed, synIdx: app.synIdx, affinity: deck() === 'word-kanji' });
        if (b.empty) {
            $('review-hint').textContent = "You've reviewed everything that's due for now. Play a board instead.";
            return;
        }
        app.boardCount++;
        notePlayed(app.span);
        app.board = {
            mode, seed, ids: b.ids, size: b.ids.length, level: app.settings.level, deck: deck(),
            keepGoing: !!app.settings.keepGoing, includeEasier: !!app.settings.includeEasier, levels: app.span.slice(), startedAt: Date.now(), activeMs: 0, lastTick: performance.now(),
            sel: { k: null, a: null }, matches: [], wrongPairs: [], gaps: {}, lastMatchAt: 0, done: false,
        };
        renderBoard(b);
        $('home').classList.add('hidden');
        $('play').classList.remove('hidden');
        const first = $('zone-kanji').querySelector('.card');
        if (first) first.focus({ preventScroll: true });
        clearInterval(app.timer);
        app.timer = setInterval(updateBar, 250);
    }

    function layoutZones() {
        const B = app.board; if (!B) return;
        const g = gridFor(B.size), zk = $('zone-kanji'), za = $('zone-answers');
        zk.style.gridTemplateColumns = `repeat(${g.kc}, minmax(0, 1fr))`; zk.style.gridTemplateRows = `repeat(${g.kr}, minmax(0, 1fr))`;
        za.style.gridTemplateColumns = `repeat(${g.ac}, minmax(0, 1fr))`; za.style.gridTemplateRows = `repeat(${g.ar}, minmax(0, 1fr))`;
        zk.dataset.cols = g.kc; za.dataset.cols = g.ac;
        $('table').classList.toggle('keys', keyLayout()); $('play').classList.toggle('keys', keyLayout());
        zk.style.setProperty('--cols', g.kc); zk.style.setProperty('--rows', g.kr);
        za.style.setProperty('--cols', g.ac); za.style.setProperty('--rows', g.ar);
    }
    window.addEventListener('resize', layoutZones);

    function renderBoard(b) {
        const B = app.board;
        const zk = $('zone-kanji'), za = $('zone-answers');
        zk.textContent = ''; za.textContent = '';
        layoutZones();
        b.kanjiOrder.forEach(id => {
            const it = app.byId.get(id);
            const c = el('button', 'card k' + (isWord(it) ? ' word' : '')); c.type = 'button';
            c.dataset.id = id; c.dataset.kind = 'k';
            c.setAttribute('aria-label', (isWord(it) ? 'word ' : 'kanji ') + it.k + (it.t ? `, highlighted ${it.t}` : '')); c.setAttribute('aria-pressed', 'false');
            c.appendChild(marked('glyph', it.k, it.hk, true));
            if (isWord(it)) c.style.setProperty('--len', Math.max(2, [...it.k].length));
            zk.appendChild(c);
        });
        const km = C.keyMap(b.kanjiOrder.length);
        b.answerOrder.forEach(id => {
            const it = app.byId.get(id);
            const c = el('button', 'card a'); c.type = 'button';
            c.dataset.id = id; c.dataset.kind = 'a';
            c.setAttribute('aria-label', `${D().back}: ` + backText(it) + (it.hr ? `, marked ${it.r.slice(it.hr[0], it.hr[1])}` : '')); c.setAttribute('aria-pressed', 'false');
            c.appendChild(marked('gl' + (isWord(it) ? ' rd' : ''), backText(it), it.hr, isWord(it)));
            za.appendChild(c);
        });
        [[zk, km.k], [za, km.a]].forEach(([z, codes]) => Array.from(z.children).forEach((c, i) => {
            if (!codes[i]) return;
            const kk = el('span', 'kk', C.keyLabel(codes[i])); kk.setAttribute('aria-hidden', 'true');
            c.appendChild(kk); c.dataset.key = codes[i];
        }));
        zk.classList.remove('hidden'); za.classList.remove('hidden');
        $('summary').classList.add('hidden');
        $('quit-bar').classList.add('hidden');
        const learn = $('learn');
        learn.classList.remove('open');
        learn.textContent = '';
        learn.appendChild(el('p', 'learn-empty', `Tap a ${D().front}, then its ${D().back}.`));
        $('zone-kanji').setAttribute('aria-label', D().front === 'word' ? 'Words' : 'Kanji');
        $('zone-answers').setAttribute('aria-label', D().back === 'reading' ? 'Readings' : 'Meanings');
        $('bar-title').textContent = (B.mode === 'review' ? (isWordDeck(deck()) ? 'Words ' : '') + 'Review' : choiceName());
        $('bar-timer').classList.toggle('hidden', !app.settings.showTimer);
        updateBar();
    }

    function tick() {
        const B = app.board; if (!B || B.done) return;
        const now = performance.now();
        if (document.visibilityState === 'visible') B.activeMs += now - B.lastTick;
        B.lastTick = now;
    }
    document.addEventListener('visibilitychange', () => {
        const B = app.board; if (!B || B.done) return;
        if (document.visibilityState === 'hidden') tick(); else B.lastTick = performance.now();
    });

    function updateBar() {
        const B = app.board; if (!B) return;
        tick();
        $('bar-left').textContent = `${B.size - B.matches.length} left`;
        $('bar-misses').textContent = `${B.wrongPairs.length} wrong`;
        $('bar-timer').textContent = fmtTime(B.activeMs);
    }

    function announce(text) { $('announce').textContent = text; }

    function select(card) {
        const B = app.board;
        if (!B || B.done || card.classList.contains('ok') || card.classList.contains('gone')) return;
        const kind = card.dataset.kind;
        if (B.sel[kind] === card) {
            card.classList.remove('sel'); card.setAttribute('aria-pressed', 'false'); B.sel[kind] = null; return;
        }
        if (B.sel[kind]) { B.sel[kind].classList.remove('sel'); B.sel[kind].setAttribute('aria-pressed', 'false'); }
        B.sel[kind] = card; card.classList.add('sel'); card.setAttribute('aria-pressed', 'true');
        if (B.sel.k && B.sel.a) tryPair(B.sel.k, B.sel.a);
    }

    function clearSel() {
        const B = app.board; if (!B) return;
        ['k', 'a'].forEach(s => { if (B.sel[s]) { B.sel[s].classList.remove('sel'); B.sel[s].setAttribute('aria-pressed', 'false'); } });
        B.sel = { k: null, a: null };
    }

    function tryPair(k, a) {
        const B = app.board;
        [k, a].forEach(c => { c.classList.remove('sel'); c.setAttribute('aria-pressed', 'false'); });
        B.sel = { k: null, a: null };
        tick();
        if (k.dataset.id === a.dataset.id) {
            const id = k.dataset.id, it = app.byId.get(id);
            B.matches.push(id);
            B.gaps[id] = Math.round(B.activeMs - B.lastMatchAt); B.lastMatchAt = B.activeMs;
            [k, a].forEach(c => { c.classList.add('ok'); c.disabled = true; c.setAttribute('aria-hidden', 'true'); });
            setTimeout(() => { k.classList.add('gone'); a.classList.add('gone'); }, 280);
            showLearn(id);
            announce(`Matched: ${it.k}, ${backText(it)}`);
            moveFocusFrom(k);
            if (B.matches.length === B.size) { B.done = true; setTimeout(() => finish(false), 320); }
        } else {
            B.wrongPairs.push({ k: k.dataset.id, a: a.dataset.id, atMs: Math.round(B.activeMs) });
            [k, a].forEach(c => {
                c.classList.remove('miss'); void c.offsetWidth; c.classList.add('miss');
                setTimeout(() => c.classList.remove('miss'), 480);
            });
            if (app.settings.vibrate && navigator.vibrate) navigator.vibrate(30);
            announce('Not a pair');
        }
        updateBar();
    }

    function moveFocusFrom(card) {
        if (document.activeElement !== card) return;
        const next = card.parentElement.querySelector('.card:not(.ok):not(.gone)') ||
                     $('zone-answers').querySelector('.card:not(.ok):not(.gone)');
        if (next) next.focus({ preventScroll: true });
    }

    function showLearn(id) {
        const it = app.byId.get(id); if (!it) return;
        app.lastShown = id;
        const p = $('learn'); p.textContent = '';
        if (isWord(it)) { showLearnWord(it, p); return; }
        const lp = el('div', 'lp');
        const tile = el('div', 'lp-tile', it.k); tile.lang = 'ja'; lp.appendChild(tile);
        lp.appendChild(el('div', 'lp-gloss', glossText(it)));
        const shown = new Set([it.gloss, it.gloss2].filter(Boolean).map(C.norm));
        const more = it.meanings.filter(m => !shown.has(C.norm(m))).slice(0, 5);
        if (more.length) lp.appendChild(el('div', 'lp-more', 'Also: ' + more.join(', ')));
        const rd = el('div', 'lp-read');
        const addReadings = (label, list, title) => {
            if (!list.length) return;
            const lab = el('span', 'lab', label); lab.title = title; rd.appendChild(lab);
            list.slice(0, 3).forEach(r => { const s = el('span', 'r', r); s.lang = 'ja'; rd.appendChild(s); });
            if (list.length > 3) rd.appendChild(el('span', 'r lab', `+${list.length - 3} more`));
        };
        addReadings('kun', it.kun, 'Japanese reading (kun\'yomi)');
        addReadings('on', it.on, 'Chinese reading (on\'yomi)');
        lp.appendChild(rd);
        const partners = C.partnersOf(confusions(), id).map(pid => app.byId.get(pid)).filter(Boolean);
        if (partners.length) {
            lp.appendChild(el('div', 'lp-mix', 'Easy to mix up with ' + partners.map(o => `${o.k} (${o.gloss})`).join(', ')));
        }
        if (it.ex.length) {
            const ul = el('ul', 'lp-ex');
            it.ex.forEach(([w, r, en]) => {
                const li = el('li');
                const ws = el('span', 'w', w); ws.lang = 'ja';
                const rs = el('span', 'rd', r); rs.lang = 'ja';
                li.append(ws, rs, document.createTextNode(en));
                ul.appendChild(li);
            });
            lp.appendChild(ul);
        }
        lp.appendChild(el('div', 'lp-meta', `${LEVEL_NAMES[it.lv]} kanji, ${plural(it.strokes, 'stroke')}`));
        p.appendChild(lp);
        p.scrollTop = 0;
    }

    function showLearnWord(it, p) {
        const lp = el('div', 'lp');
        const tile = marked('lp-tile word', it.k, it.hk, true); lp.appendChild(tile);
        const rd = marked('lp-gloss', it.r, it.hr, true); lp.appendChild(rd);
        lp.appendChild(el('div', 'lp-more', it.gloss));
        if (it.alt && it.alt.length) {
            const a = el('div', 'lp-more', 'Also read: ' + it.alt.join(', ')); a.lang = 'ja'; lp.appendChild(a);
        }
        const parts = (it.split || '').split(';').map(x => x.split(':')).filter(x => x.length === 2);
        if (parts.length) {
            const row = el('div', 'lp-read');
            parts.forEach(([k, r]) => {
                const s = el('span', 'r' + (k === it.t ? ' on' : ''), `${k} ${r}`); s.lang = 'ja'; row.appendChild(s);
            });
            lp.appendChild(row);
        }
        const partners = C.partnersOf(confusions(), it.id).map(pid => app.byId.get(pid)).filter(Boolean);
        if (partners.length) {
            const m = el('div', 'lp-mix', 'Easy to mix up with ' + partners.map(o => `${o.k} (${o.r})`).join(', ')); m.lang = 'ja';
            lp.appendChild(m);
        }
        lp.appendChild(el('div', 'lp-meta', `${LEVEL_NAMES[it.lv]} word (its hardest kanji is ${LEVEL_NAMES[it.lv]})`));
        p.appendChild(lp);
        p.scrollTop = 0;
    }

    async function finish(abandoned) {
        const B = app.board;
        tick(); B.done = true;
        clearInterval(app.timer);
        const now = Date.now(), day = C.studyDay(now);
        const record = { size: B.size, ids: B.ids, matches: B.matches, wrongPairs: B.wrongPairs, abandoned };
        const r = C.applyBoard({ record, states: items(), confusions: confusions(), today: day, now });
        const newItems = Object.assign({}, items(), r.changed);
        const result = {
            id: S.uuid(), schema: 1, userId: app.saved.meta.userId, deviceId: app.saved.meta.deviceId,
            appVersion: APP_VERSION, dataBuild: app.meta.build, deck: B.deck,
            level: B.level, levels: B.levels, keepGoing: B.keepGoing, mode: B.mode, size: B.size,
            startedAt: B.startedAt, endedAt: now, activeMs: Math.round(B.activeMs), misses: B.wrongPairs.length,
            abandoned, seed: B.seed,
            items: B.ids.map(id => { const g = r.grades[id]; return { id, rank: g.rank, m: g.m, kSide: g.kSide, aSide: g.aSide, grade: g.grade, gapMs: B.gaps[id] ?? null }; }),
            wrongPairs: B.wrongPairs,
        };
        const bests = Object.assign({}, app.saved.bests);
        const key = C.bestKey(B.deck, B.level, B.includeEasier, B.size);
        const prevBest = bests[key];
        let newBest = false;
        if (!abandoned && B.mode === 'play' && B.size === app.settings.size && C.isBetter(result, prevBest)) {
            bests[key] = { misses: result.misses, activeMs: result.activeMs, boardId: result.id, at: now };
            newBest = true;
        }
        let saveError = null;
        try {
            await app.store.saveBoard({ deck: B.deck, items: newItems, confusions: r.confusions, bests, result,
                day: { key: day, boards: abandoned ? 0 : 1, misses: result.misses, activeMs: result.activeMs } });
        } catch (e) { saveError = e; }
        app.saved.items[B.deck] = newItems;
        app.saved.confusions[B.deck] = r.confusions;
        app.saved.bests = bests;
        app.saved.days = (await app.store.load()).days;
        app.saved.meta = (await app.store.load()).meta;
        app.recent.unshift(B.ids); app.recent.length = Math.min(app.recent.length, 3);
        if (app.sync) app.sync.boardDone();

        if (abandoned) { goHome(); return; }
        showSummary(result, r.grades, newBest, prevBest, saveError);
    }

    function showSummary(result, grades, newBest, prevBest, saveError) {
        const B = app.board;
        $('zone-kanji').classList.add('hidden'); $('zone-answers').classList.add('hidden');
        const s = $('summary'); s.textContent = '';
        const inner = el('div', 'summary-inner');
        inner.appendChild(el('h2', null, result.misses ? 'Board cleared' : 'Clean board'));
        const stats = el('div', 'stats');
        const stat = (v, l) => { const d = el('div'); d.append(el('b', null, v), el('span', null, l)); stats.appendChild(d); };
        stat(fmtTime(result.activeMs), 'time');
        stat(String(result.misses), result.misses === 1 ? 'wrong pair' : 'wrong pairs');
        stat(`${C.firstTry(grades)} of ${B.size}`, 'first try');
        inner.appendChild(stats);
        let note = '';
        if (B.mode === 'review') note = `Review boards mix the ${D().items[1]} you need most, so they don't count for bests.`;
        else if (newBest) note = prevBest ? `New best for ${choiceName()}, ${B.size} pairs.` : `First best for ${choiceName()}, ${B.size} pairs.`;
        else if (prevBest) note = `Best for ${choiceName()}, ${B.size} pairs: ${plural(prevBest.misses, 'wrong pair')} in ${fmtTime(prevBest.activeMs)}.`;
        const n = el('p', 'best-note' + (newBest ? ' new' : ''), note);
        inner.appendChild(n);
        if (saveError) inner.appendChild(el('p', 'notice', "Progress couldn't be saved (the browser's storage may be full). Export a backup from Home."));

        // Only kanji that were in a wrong pair. Being cleared late is tracked quietly, not shown.
        const again = Object.values(grades).filter(g => g.kSide > 0 || g.aSide > 0)
            .sort((a, b) => b.kSide - a.kSide || b.aSide - a.aSide);
        if (again.length) {
            inner.appendChild(el('p', 'again-title', 'Worth another look'));
            const box = el('div', 'again');
            again.forEach(g => {
                const it = app.byId.get(g.id);
                const bt = el('button'); bt.type = 'button';
                bt.append(marked('k', it.k, it.hk, true), marked('m', isWord(it) ? it.r : it.gloss, it.hr, isWord(it)));
                bt.setAttribute('aria-label', `Show ${it.k}, ${backText(it)}`);
                bt.addEventListener('click', () => { showLearn(g.id); $('learn').classList.add('open'); });
                box.appendChild(bt);
            });
            inner.appendChild(box);
        }
        const row = el('div', 'row');
        const next = el('button', 'btn primary', 'Next board'); next.type = 'button';
        const home = el('button', 'btn', 'Home'); home.type = 'button';
        next.addEventListener('click', () => startBoard(B.mode));
        home.addEventListener('click', goHome);
        row.append(next, home);
        inner.appendChild(row);
        s.appendChild(inner);
        s.classList.remove('hidden');
        next.focus({ preventScroll: true });
    }

    function goHome() {
        clearInterval(app.timer);
        app.board = null;
        if (app.syncPending) { reloadSaved(); }
        $('play').classList.add('hidden');
        $('home').classList.remove('hidden');
        renderHome();
        $('play-btn').focus({ preventScroll: true });
    }

    function askQuit(show) {
        const B = app.board; if (!B) return;
        if (B.done) { goHome(); return; }
        $('quit-bar').classList.toggle('hidden', !show);
        if (show) $('quit-no').focus();
    }

    function bindBoard() {
        $('table').addEventListener('click', e => {
            const card = e.target.closest('.card');
            if (card) select(card);
        });
        $('quit-btn').addEventListener('click', () => askQuit(true));
        $('quit-no').addEventListener('click', () => { askQuit(false); const c = $('table').querySelector('.card:not(.gone)'); if (c) c.focus(); });
        $('quit-yes').addEventListener('click', () => { $('quit-bar').classList.add('hidden'); if (app.board && !app.board.done) finish(true); });
        $('learn').addEventListener('click', e => {
            if (e.target.closest('a,button')) return;
            if (window.matchMedia(WIDE_LAYOUT).matches) return;
            $('learn').classList.toggle('open');
        });
        document.addEventListener('keydown', e => {
            if ($('play').classList.contains('hidden')) return;
            const B = app.board;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (B && !B.done && (B.sel.k || B.sel.a) && $('quit-bar').classList.contains('hidden')) { clearSel(); return; }
                askQuit($('quit-bar').classList.contains('hidden')); return;
            }
            if (B && !B.done && keyLayout() && $('quit-bar').classList.contains('hidden') && C.keyAllowed(e.target)) {
                const t = C.keyTarget(e, B.ids.length);
                if (t) {
                    e.preventDefault();
                    const c = $(t.side === 'k' ? 'zone-kanji' : 'zone-answers').children[t.index];
                    if (c && !c.classList.contains('ok') && !c.classList.contains('gone')) select(c);
                    return;
                }
            }
            const card = e.target.closest && e.target.closest('.zone .card');
            if (!card) return;
            const dir = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 'up', ArrowDown: 'down' }[e.key];
            if (!dir) return;
            e.preventDefault();
            const zone = card.parentElement, cards = Array.from(zone.children), cols = Number(zone.dataset.cols);
            const step = dir === 'up' ? -cols : dir === 'down' ? cols : dir;
            let i = cards.indexOf(card) + step;
            while (i >= 0 && i < cards.length && cards[i].classList.contains('gone')) i += step;
            if (i >= 0 && i < cards.length) cards[i].focus();
        });
    }

    init().catch(e => { console.error(e); showWarning('Kanji Match could not start: ' + e.message); });
}());
