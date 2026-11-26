// Kanji Match: saving progress. One async interface, so a later standalone app can swap
// localStorage for IndexedDB or a server without touching the game code.
//
//   const store = MatchStore.local();            // browser (window.localStorage)
//   const store = MatchStore.memory();           // tests
//   await store.load()            → { meta, settings, items, confusions, bests, days, log }
//   await store.saveBoard({ deck, items, confusions, bests, day, result })
//   await store.saveSettings(settings) / store.saveMeta(patch)
//   await store.applySync(merged => …)    (cloud sync: write merged progress, never the log)
//   await store.exportAll() → object;  await store.importAll(object);  await store.reset()
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MatchStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PREFIX = 'nihongoMatch.v1.';
    const SCHEMA = 1;
    const FORMAT = 'nihongo-match-export';
    const LOG_KEEP = 300;          // finished boards kept in the history log
    const DECKS = ['kanji-meaning', 'word-reading'];

    function uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function memoryStorage() {
        const m = new Map();
        return {
            getItem: k => (m.has(k) ? m.get(k) : null),
            setItem: (k, v) => { m.set(k, String(v)); },
            removeItem: k => { m.delete(k); },
            key: i => Array.from(m.keys())[i] ?? null,
            get length() { return m.size; },
            _map: m,
        };
    }

    // JSON with sorted keys, to compare data whatever order its keys were built in
    function stable(v) {
        if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
        if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
            .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
        return JSON.stringify(v === undefined ? null : v);
    }

    function isQuota(e) {
        return e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''));
    }

    function create(storage) {
        const warnings = [];

        function read(key, fallback) {
            const raw = storage.getItem(PREFIX + key);
            if (raw === null) return fallback;
            try {
                return JSON.parse(raw);
            } catch (e) {
                // Keep the broken text aside so nothing is lost, then start that part fresh.
                try { storage.setItem(PREFIX + 'corrupt.' + key + '.' + Date.now(), raw); } catch (_) { /* full */ }
                storage.removeItem(PREFIX + key);
                warnings.push(`Saved data "${key}" was damaged and has been reset (a copy was kept).`);
                return fallback;
            }
        }
        function write(key, value) { storage.setItem(PREFIX + key, JSON.stringify(value)); }

        function writeAll(pairs) {
            // Write the log last; if storage is full, shrink the log and try again.
            const log = pairs.find(p => p[0] === 'log');
            const rest = pairs.filter(p => p[0] !== 'log');
            for (const [k, v] of rest) write(k, v);
            if (!log) return;
            let entries = log[1];
            for (;;) {
                try { write('log', entries); return; } catch (e) {
                    if (!isQuota(e) || entries.length === 0) throw e;
                    entries = entries.slice(Math.floor(entries.length / 2));
                    if (entries.length <= 1) entries = [];
                }
            }
        }

        function meta() {
            let m = read('meta', null);
            if (!m || m.schema !== SCHEMA) {
                m = { schema: SCHEMA, userId: 'local', deviceId: uuid(), createdAt: Date.now(),
                      lastExportAt: null, boardsSinceExport: 0 };
                write('meta', m);
            }
            return m;
        }

        async function load() {
            const items = {}, confusions = {};
            DECKS.forEach(d => { items[d] = read('items.' + d, {}); confusions[d] = read('confusions.' + d, {}); });
            return {
                meta: meta(), settings: read('settings', {}), items, confusions,
                bests: read('bests', {}), days: read('days', {}), log: read('log', []),
                warnings: warnings.splice(0),
            };
        }

        // items: the deck's full item map; confusions: the deck's full map; bests: full map;
        // day: { key: 'YYYY-MM-DD', boards, misses, activeMs } to add; result: BoardResult
        async function saveBoard({ deck, items, confusions, bests, day, result }) {
            const days = read('days', {});
            if (day) {
                const d = days[day.key] || { boards: 0, misses: 0, activeMs: 0 };
                d.boards += day.boards || 0; d.misses += day.misses || 0; d.activeMs += day.activeMs || 0;
                days[day.key] = d;
            }
            const log = read('log', []);
            if (result) { log.push(result); while (log.length > LOG_KEEP) log.shift(); }
            const m = meta();
            if (result && !result.abandoned) m.boardsSinceExport = (m.boardsSinceExport || 0) + 1;
            writeAll([
                ['items.' + deck, items], ['confusions.' + deck, confusions], ['bests', bests],
                ['days', days], ['meta', m], ['log', log],
            ]);
        }

        // Cloud sync (match_sync.js): fn(current) returns the merged { settings, bests, days, items, confusions };
        // changed parts are written in the same call (no await in between, so nothing saved meanwhile is lost).
        // The log and meta are never touched. Returns true if anything changed.
        async function applySync(fn) {
            const cur = { settings: read('settings', {}), bests: read('bests', {}), days: read('days', {}), items: {}, confusions: {} };
            DECKS.forEach(d => { cur.items[d] = read('items.' + d, {}); cur.confusions[d] = read('confusions.' + d, {}); });
            const m = fn(cur);
            const pairs = [];
            const add = (key, a, b) => { if (stable(a) !== stable(b)) pairs.push([key, b]); };
            add('settings', cur.settings, m.settings); add('bests', cur.bests, m.bests); add('days', cur.days, m.days);
            DECKS.forEach(d => { add('items.' + d, cur.items[d], m.items[d]); add('confusions.' + d, cur.confusions[d], m.confusions[d]); });
            writeAll(pairs);
            return pairs.length > 0;
        }

        async function saveSettings(settings) { write('settings', settings); }
        async function saveMeta(patch) { write('meta', Object.assign(meta(), patch)); }

        async function exportAll() {
            const s = await load();
            const decks = {};
            DECKS.forEach(d => { decks[d] = { items: s.items[d], confusions: s.confusions[d] }; });
            return { format: FORMAT, schema: SCHEMA, exportedAt: new Date().toISOString(),
                     meta: s.meta, settings: s.settings, decks, bests: s.bests, days: s.days, log: s.log };
        }

        function validate(obj) {
            if (!obj || obj.format !== FORMAT) throw new Error('This file is not a Kanji Match backup.');
            if (obj.schema !== SCHEMA) throw new Error(`This backup has version ${obj.schema}; this page reads version ${SCHEMA}.`);
            if (!obj.decks || typeof obj.decks !== 'object') throw new Error('The backup has no progress in it.');
            return true;
        }
        function summary(obj) {
            validate(obj);
            const items = Object.values(obj.decks).reduce((n, d) => n + Object.keys(d.items || {}).length, 0);
            const boards = Object.values(obj.days || {}).reduce((n, d) => n + (d.boards || 0), 0);
            return { items, boards, exportedAt: obj.exportedAt };
        }

        async function importAll(obj) {
            validate(obj);
            await reset({ keepMeta: true });
            const pairs = [];
            DECKS.forEach(d => {
                const deck = obj.decks[d] || {};
                pairs.push(['items.' + d, deck.items || {}], ['confusions.' + d, deck.confusions || {}]);
            });
            pairs.push(['bests', obj.bests || {}], ['days', obj.days || {}], ['settings', obj.settings || {}],
                       ['log', obj.log || []]);
            writeAll(pairs);
        }

        async function reset(opts) {
            const keys = [];
            for (let i = 0; i < storage.length; i++) {
                const k = storage.key(i);
                if (k && k.startsWith(PREFIX) && !(opts && opts.keepMeta && k === PREFIX + 'meta')) keys.push(k);
            }
            keys.forEach(k => storage.removeItem(k));
        }

        return { load, saveBoard, saveSettings, saveMeta, applySync, exportAll, importAll, summary, reset, validate,
                 _storage: storage };
    }

    return {
        PREFIX, SCHEMA, FORMAT, LOG_KEEP, uuid, memoryStorage, create, stable,
        local: () => create(window.localStorage),
        memory: () => create(memoryStorage()),
    };
}));
