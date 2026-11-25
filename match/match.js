// Kanji Match: page UI (Home, Board, Summary). Game rules live in match_core.js,
// saving in match_store.js. Nothing about boxes or review scheduling is shown during play.
(function () {
    'use strict';

    const C = window.MatchCore, S = window.MatchStore;
    const APP_VERSION = '1.0';
    const DECK = 'kanji-meaning';
    const LEVEL_NAMES = { N5: 'N5', N4: 'N4', N3: 'N3', N2: 'N2', N1: 'N1', X: 'Extras' };
    const DEFAULTS = { level: 'N5', includeLower: false, size: 8, showTimer: true, vibrate: true,
                       iosTipDismissed: false, persistAsked: false };
    const params = new URLSearchParams(location.search);
    const TEST_SEED = params.has('seed') ? Number(params.get('seed')) : null;
    const $ = id => document.getElementById(id);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    const app = {
        meta: null, synIdx: null, levels: {}, byId: new Map(),
        store: null, saved: null, settings: Object.assign({}, DEFAULTS),
        recent: [], board: null, boardCount: 0, timer: null, lastShown: null,
    };
    if (params.has('test')) window.__match = app;

    // ------------------------------------------------------------------ helpers
    const items = () => app.saved.items[DECK];
    const confusions = () => app.saved.confusions[DECK];
    const today = () => C.studyDay(Date.now());
    const fmtTime = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
    const glossText = it => it.gloss + (it.gloss2 ? ', ' + it.gloss2 : '');
    const poolLevels = () => C.poolLevels(app.settings.level, app.settings.includeLower);
    const choiceName = () => {
        const { level, includeLower } = app.settings;
        if (includeLower && level === 'X') return 'All levels';
        return LEVEL_NAMES[level] + (includeLower && level !== 'N5' ? ' and below' : '');
    };

    function showWarning(text) {
        const w = $('home-warning');
        w.textContent = text; w.classList.toggle('hidden', !text);
    }

    async function loadLevels(levels) {
        const need = levels.filter(lv => !app.levels[lv]);
        await Promise.all(need.map(async lv => {
            const info = app.meta.levels[lv];
            const res = await fetch(`data/${info.file}?b=${app.meta.build}`);
            if (!res.ok) throw new Error(`Couldn't load ${info.file} (${res.status})`);
            const doc = await res.json();
            app.levels[lv] = doc.items;
            doc.items.forEach(it => app.byId.set(it.id, it));
        }));
        return levels.flatMap(lv => app.levels[lv]);
    }

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
        if (app.saved.warnings && app.saved.warnings.length) showWarning(app.saved.warnings.join(' '));
        // Last boards from the log, so spacing still works after a reload.
        app.recent = (app.saved.log || []).filter(r => r.deck === DECK).slice(-3).reverse().map(r => r.items.map(i => i.id));

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
    }

    function saveSettings() { app.store.saveSettings(app.settings).catch(() => {}); }

    function applySettingsToForm() {
        const f = $('setup');
        f.querySelector(`input[name="level"][value="${app.settings.level}"]`).checked = true;
        const size = f.querySelector(`input[name="size"][value="${app.settings.size}"]`);
        if (size) size.checked = true;
        $('include-lower').checked = !!app.settings.includeLower;
        $('opt-timer').checked = !!app.settings.showTimer;
        $('opt-vibrate').checked = !!app.settings.vibrate;
    }

    // ------------------------------------------------------------------ home
    function bindHome() {
        const f = $('setup');
        f.addEventListener('change', e => {
            if (e.target.name === 'level') app.settings.level = e.target.value;
            if (e.target.name === 'size') app.settings.size = Number(e.target.value);
            if (e.target.id === 'include-lower') app.settings.includeLower = e.target.checked;
            saveSettings(); renderHome();
        });
        f.addEventListener('submit', e => { e.preventDefault(); startBoard('play'); });
        $('review-btn').addEventListener('click', () => startBoard('review'));
        $('opt-timer').addEventListener('change', e => { app.settings.showTimer = e.target.checked; saveSettings(); });
        $('opt-vibrate').addEventListener('change', e => { app.settings.vibrate = e.target.checked; saveSettings(); });
        $('export-btn').addEventListener('click', exportProgress);
        $('import-file').addEventListener('change', importProgress);
        $('reset-btn').addEventListener('click', confirmReset);
        $('ios-tip-close').addEventListener('click', () => { app.settings.iosTipDismissed = true; saveSettings(); $('ios-tip').classList.add('hidden'); });
    }

    async function renderHome() {
        $('extras-hint').classList.toggle('hidden', app.settings.level !== 'X');
        let pool;
        try { pool = await loadLevels(poolLevels()); } catch (e) { showWarning(e.message); return; }
        const st = items(), day = today();

        // progress bars
        const bars = $('progress-bars'); bars.textContent = '';
        for (const lv of poolLevels()) {
            const counts = { strong: 0, learning: 0, weak: 0, unseen: 0 };
            app.levels[lv].forEach(it => { counts[C.band(st[it.id])]++; });
            const total = app.levels[lv].length;
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
        const due = pool.filter(it => st[it.id] && (st[it.id].box === 1 || st[it.id].due <= day)).length;
        const rb = $('review-btn');
        rb.textContent = due ? `Review (${due})` : 'Review';
        rb.disabled = !due;
        let hint = '';
        if (!due) {
            const future = pool.map(it => st[it.id]).filter(Boolean).map(s => s.due).filter(d => d > day).sort();
            if (future.length) {
                const next = future[0], n = future.filter(d => d === next).length;
                const when = C.dayDiff(day, next) === 1 ? 'tomorrow' : `on ${next}`;
                hint = `Nothing to review right now. ${plural(n, 'kanji', 'kanji')} come back ${when}.`;
            } else if (!pool.some(it => st[it.id])) {
                hint = 'Review opens once you have played a board.';
            }
        }
        $('review-hint').textContent = hint;

        // facts: boards today, streak, best for this choice
        const days = app.saved.days || {};
        let d = day, streak = 0;
        if (!(days[d] && days[d].boards)) d = C.addDays(d, -1);
        while (days[d] && days[d].boards) { streak++; d = C.addDays(d, -1); }
        const best = app.saved.bests[C.bestKey(DECK, app.settings.level, app.settings.includeLower, app.settings.size)];
        const facts = [];
        facts.push(`Boards today: ${(days[day] && days[day].boards) || 0}.`);
        if (streak) facts.push(`Study streak: ${plural(streak, 'day')}.`);
        if (best) facts.push(`Best for ${choiceName()}, ${app.settings.size} pairs: ${plural(best.misses, 'wrong pair')} in ${fmtTime(best.activeMs)}.`);
        $('progress-facts').textContent = facts.join(' ');

        // kanji that keep slipping
        const trouble = pool.filter(it => C.isTrouble(st[it.id]));
        $('trouble').classList.toggle('hidden', !trouble.length);
        $('trouble-count').textContent = trouble.length;
        const tl = $('trouble-list'); tl.textContent = '';
        trouble.forEach(it => {
            const c = el('span', 'chip');
            const k = el('span', 'k', it.k); k.lang = 'ja';
            c.append(k, el('span', 'm', glossText(it)));
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
        confirmBox([el('p', null, `This backup has ${plural(sum.items, 'kanji', 'kanji')} and ${plural(sum.boards, 'board')}, exported ${when}. Importing replaces the progress in this browser.`), yes, no]);
        no.onclick = closeConfirm;
        yes.onclick = async () => {
            await app.store.importAll(obj);
            app.saved = await app.store.load();
            Object.assign(app.settings, DEFAULTS, app.saved.settings || {});
            app.recent = [];
            applySettingsToForm(); closeConfirm(); showWarning('Backup imported.'); renderHome();
        };
    }

    function confirmReset() {
        const input = el('input'); input.type = 'text'; input.setAttribute('aria-label', 'Type reset to confirm');
        const yes = el('button', 'btn small danger-quiet', 'Reset progress');
        const no = el('button', 'btn small', 'Cancel');
        yes.type = no.type = 'button'; yes.disabled = true;
        input.oninput = () => { yes.disabled = input.value.trim().toLowerCase() !== 'reset'; };
        confirmBox([el('p', null, 'This deletes all progress, bests and history in this browser. Export a backup first if you might want it back. Type "reset" to confirm.'), input, yes, no]);
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
    const SHORT_LANDSCAPE = '(orientation: landscape) and (max-height: 500px) and (min-width: 560px)';
    function gridFor(n) {
        const kc = n <= 6 ? 3 : 4;
        const ac = (n <= 8 || window.matchMedia(SHORT_LANDSCAPE).matches) ? 2 : 3;
        return { kc, kr: Math.ceil(n / kc), ac, ar: Math.ceil(n / ac) };
    }

    async function startBoard(mode) {
        let pool;
        try { pool = await loadLevels(poolLevels()); } catch (e) { showWarning(e.message); return; }
        const seed = TEST_SEED !== null ? TEST_SEED + app.boardCount : ((Date.now() ^ (Math.random() * 4294967296)) >>> 0);
        const b = C.buildBoard({ pool, states: items(), confusions: confusions(), size: app.settings.size, mode,
                                 recent: app.recent, today: today(), seed, synIdx: app.synIdx });
        if (b.empty) {
            $('review-hint').textContent = "You've reviewed everything that's due for now. Play a board instead.";
            return;
        }
        app.boardCount++;
        app.board = {
            mode, seed, ids: b.ids, size: b.ids.length, level: app.settings.level, includeLower: app.settings.includeLower,
            levels: poolLevels(), startedAt: Date.now(), activeMs: 0, lastTick: performance.now(),
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
            const c = el('button', 'card k'); c.type = 'button';
            c.dataset.id = id; c.dataset.kind = 'k';
            c.setAttribute('aria-label', 'kanji ' + it.k); c.setAttribute('aria-pressed', 'false');
            const s = el('span', 'glyph', it.k); s.lang = 'ja'; c.appendChild(s);
            zk.appendChild(c);
        });
        b.answerOrder.forEach(id => {
            const it = app.byId.get(id);
            const c = el('button', 'card a'); c.type = 'button';
            c.dataset.id = id; c.dataset.kind = 'a';
            c.setAttribute('aria-label', 'meaning: ' + glossText(it)); c.setAttribute('aria-pressed', 'false');
            c.appendChild(el('span', 'gl', glossText(it)));
            za.appendChild(c);
        });
        zk.classList.remove('hidden'); za.classList.remove('hidden');
        $('summary').classList.add('hidden');
        $('quit-bar').classList.add('hidden');
        const learn = $('learn');
        learn.classList.remove('open');
        learn.textContent = '';
        learn.appendChild(el('p', 'learn-empty', 'Tap a kanji, then its meaning.'));
        $('bar-title').textContent = choiceName() + (B.mode === 'review' ? ', review' : '');
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
            announce(`Matched: ${it.k}, ${glossText(it)}`);
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
            appVersion: APP_VERSION, dataBuild: app.meta.build, deck: DECK,
            level: B.level, levels: B.levels, includeLower: B.includeLower, mode: B.mode, size: B.size,
            startedAt: B.startedAt, endedAt: now, activeMs: Math.round(B.activeMs), misses: B.wrongPairs.length,
            abandoned, seed: B.seed,
            items: B.ids.map(id => { const g = r.grades[id]; return { id, rank: g.rank, m: g.m, kSide: g.kSide, aSide: g.aSide, grade: g.grade, gapMs: B.gaps[id] ?? null }; }),
            wrongPairs: B.wrongPairs,
        };
        const bests = Object.assign({}, app.saved.bests);
        const key = C.bestKey(DECK, B.level, B.includeLower, B.size);
        const prevBest = bests[key];
        let newBest = false;
        if (!abandoned && B.mode === 'play' && B.size === app.settings.size && C.isBetter(result, prevBest)) {
            bests[key] = { misses: result.misses, activeMs: result.activeMs, boardId: result.id, at: now };
            newBest = true;
        }
        let saveError = null;
        try {
            await app.store.saveBoard({ deck: DECK, items: newItems, confusions: r.confusions, bests, result,
                day: { key: day, boards: abandoned ? 0 : 1, misses: result.misses, activeMs: result.activeMs } });
        } catch (e) { saveError = e; }
        app.saved.items[DECK] = newItems;
        app.saved.confusions[DECK] = r.confusions;
        app.saved.bests = bests;
        app.saved.days = (await app.store.load()).days;
        app.saved.meta = (await app.store.load()).meta;
        app.recent.unshift(B.ids); app.recent.length = Math.min(app.recent.length, 3);

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
        if (B.mode === 'review') note = 'Review boards mix the kanji you need most, so they don\'t count for bests.';
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
                const k = el('span', 'k', it.k); k.lang = 'ja';
                bt.append(k, el('span', 'm', it.gloss));
                bt.setAttribute('aria-label', `Show ${it.k}, ${glossText(it)}`);
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
            if (window.matchMedia('(min-width: 760px), (orientation: landscape) and (min-width: 560px)').matches) return;
            $('learn').classList.toggle('open');
        });
        document.addEventListener('keydown', e => {
            if ($('play').classList.contains('hidden')) return;
            if (e.key === 'Escape') { e.preventDefault(); askQuit($('quit-bar').classList.contains('hidden')); return; }
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
