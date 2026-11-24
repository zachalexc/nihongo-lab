// Endless mode: saving progress on the device. One async interface over three backends:
//
//   const store = await SrsStore.local();     // browser: IndexedDB, or localStorage if IndexedDB won't open
//   const store = SrsStore.memory();          // tests
//   await store.load()       -> { meta, states: { key: state }, warnings: [...] }
//   await store.saveAnswer({ key, state, logEntry, metaPatch })   // one write per answer
//   await store.saveMeta(patch);  await store.getLog()
//   await store.exportAll() -> object;  store.summary(obj);  await store.importAll(obj);  await store.reset()
//
// Progress holds only item keys and stats (no class data). The answer log stays on the device.
// Interface shape, uuid(), memoryStorage() and the damaged-data / quota handling are copied from
// match/match_store.js (Kanji Match), which stays a separate, uncommitted project.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SrsStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SCHEMA = 2;               // v2 "Flow" (FSRS state); a schema-1 store is cleared on load
    const FORMAT = 'nihongo-endless-export';
    const LOG_KEEP = 2000;
    const DB_NAME = 'nihongoEndless';
    const PREFIX = 'nihongoEndless.v1.';

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

    function isQuota(e) {
        return e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''));
    }

    function freshMeta() {
        return { schema: SCHEMA, deviceId: uuid(), createdAt: Date.now(), baseline: [], answerCount: 0,
                 typoLastAt: null, persistAsked: false, lastExportAt: null, W: 6, accWindow: [] };
    }

    // ---------------------------------------------------------------- backends
    // A backend has: getMeta, putMeta, getItems, putItem, appendLog, getLog, setLog, clear.

    function storageBackend(storage) {
        const warnings = [];
        function read(key, fallback) {
            const raw = storage.getItem(PREFIX + key);
            if (raw === null) return fallback;
            try { return JSON.parse(raw); } catch (e) {
                // Keep the broken text aside so nothing is lost, then start that part fresh.
                try { storage.setItem(PREFIX + 'corrupt.' + key + '.' + Date.now(), raw); } catch (_) { /* full */ }
                storage.removeItem(PREFIX + key);
                warnings.push(`Saved endless data "${key}" was damaged and has been reset (a copy was kept).`);
                return fallback;
            }
        }
        const write = (key, value) => storage.setItem(PREFIX + key, JSON.stringify(value));
        function writeLog(entries) {
            // If storage is full, shrink the log and try again.
            for (;;) {
                try { write('log', entries); return; } catch (e) {
                    if (!isQuota(e) || entries.length === 0) throw e;
                    entries = entries.slice(Math.floor(entries.length / 2));
                    if (entries.length <= 1) entries = [];
                }
            }
        }
        return {
            kind: 'storage', warnings,
            async getMeta() { return read('meta', null); },
            async putMeta(m) { write('meta', m); },
            async getItems() { return read('items', {}); },
            async putItem(key, state) { const all = read('items', {}); all[key] = state; write('items', all); },
            async putItems(map) { write('items', map); },
            async appendLog(entry) {
                const log = read('log', []);
                log.push(entry);
                while (log.length > LOG_KEEP) log.shift();
                writeLog(log);
            },
            async getLog() { return read('log', []); },
            async setLog(entries) { writeLog(entries.slice(-LOG_KEEP)); },
            async clear(keepMeta) {
                const keys = [];
                for (let i = 0; i < storage.length; i++) {
                    const k = storage.key(i);
                    if (k && k.startsWith(PREFIX) && !k.startsWith(PREFIX + 'corrupt.') && !(keepMeta && k === PREFIX + 'meta')) keys.push(k);
                }
                keys.forEach(k => storage.removeItem(k));
            },
        };
    }

    // IndexedDB: stores "items" (keyPath key), "meta" (one record, key "meta"), "log" (autoIncrement).
    function idbBackend(db) {
        const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
        const strip = rec => { const s = Object.assign({}, rec); delete s.key; return s; };
        async function trimLog(tx) {
            const store = tx.objectStore('log');
            const n = await req2p(store.count());
            if (n <= LOG_KEEP) return;
            let extra = n - LOG_KEEP;
            await new Promise((res, rej) => {
                const cur = store.openCursor();
                cur.onsuccess = () => {
                    const c = cur.result;
                    if (!c || extra <= 0) return res();
                    c.delete(); extra--; c.continue();
                };
                cur.onerror = () => rej(cur.error);
            });
        }
        return {
            kind: 'indexeddb', warnings: [], db,
            async getMeta() { const tx = db.transaction('meta'); return (await req2p(tx.objectStore('meta').get('meta'))) || null; },
            async putMeta(m) { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(m, 'meta'); await done(tx); },
            async getItems() {
                const tx = db.transaction('items');
                const all = await req2p(tx.objectStore('items').getAll());
                const out = {};
                for (const rec of all) out[rec.key] = strip(rec);
                return out;
            },
            async putItem(key, state) {
                const tx = db.transaction('items', 'readwrite');
                tx.objectStore('items').put(Object.assign({ key }, state));
                await done(tx);
            },
            async putItems(map) {
                const tx = db.transaction('items', 'readwrite');
                const st = tx.objectStore('items');
                st.clear();
                for (const [key, state] of Object.entries(map)) st.put(Object.assign({ key }, state));
                await done(tx);
            },
            // One transaction per answer: item state, log entry and meta together.
            async saveAnswer({ key, state, logEntry, meta }) {
                const tx = db.transaction(['items', 'log', 'meta'], 'readwrite');
                if (key) tx.objectStore('items').put(Object.assign({ key }, state));
                if (meta) tx.objectStore('meta').put(meta, 'meta');
                if (logEntry) { tx.objectStore('log').add(logEntry); await trimLog(tx); }
                await done(tx);
            },
            async appendLog(entry) {
                const tx = db.transaction('log', 'readwrite');
                tx.objectStore('log').add(entry);
                await trimLog(tx);
                await done(tx);
            },
            async getLog() { const tx = db.transaction('log'); return req2p(tx.objectStore('log').getAll()); },
            async setLog(entries) {
                const tx = db.transaction('log', 'readwrite');
                const st = tx.objectStore('log');
                st.clear();
                for (const e of entries.slice(-LOG_KEEP)) st.add(e);
                await done(tx);
            },
            async clear(keepMeta) {
                const names = keepMeta ? ['items', 'log'] : ['items', 'log', 'meta'];
                const tx = db.transaction(names, 'readwrite');
                names.forEach(n => tx.objectStore(n).clear());
                await done(tx);
            },
        };
    }

    function openIdb(idb) {
        return new Promise((res, rej) => {
            let r;
            try { r = idb.open(DB_NAME, 1); } catch (e) { rej(e); return; }
            r.onupgradeneeded = () => {
                const db = r.result;
                if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
                if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { autoIncrement: true });
            };
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
            r.onblocked = () => rej(new Error('IndexedDB is blocked by another tab'));
        });
    }

    // ---------------------------------------------------------------- the store
    function create(backend) {
        let metaCache = null;

        async function meta() {
            if (metaCache) return metaCache;
            let m = await backend.getMeta();
            if (m && m.schema !== SCHEMA) {
                // Progress from an older version of the mode is not migrated: start fresh, say so once.
                await backend.clear(false);
                backend.warnings.push('Endless progress was reset for the new version.');
                m = null;
            }
            if (!m) { m = freshMeta(); await backend.putMeta(m); }
            metaCache = m;
            return m;
        }

        async function load() {
            const m = await meta();
            const states = await backend.getItems();
            return { meta: Object.assign({}, m), states, warnings: backend.warnings.splice(0), backend: backend.kind };
        }

        async function saveAnswer({ key, state, logEntry, metaPatch }) {
            const m = Object.assign(await meta(), metaPatch || {});
            metaCache = m;
            if (backend.saveAnswer) return backend.saveAnswer({ key, state, logEntry, meta: m });
            if (key) await backend.putItem(key, state);
            if (logEntry) await backend.appendLog(logEntry);
            await backend.putMeta(m);
        }

        async function saveMeta(patch) {
            const m = Object.assign(await meta(), patch || {});
            metaCache = m;
            await backend.putMeta(m);
        }

        async function getLog() { return backend.getLog(); }

        async function exportAll() {
            const m = await meta();
            return { format: FORMAT, schema: SCHEMA, exportedAt: new Date().toISOString(),
                     meta: Object.assign({}, m), items: await backend.getItems(), log: await backend.getLog() };
        }

        function validate(obj) {
            if (!obj || obj.format !== FORMAT) throw new Error('This file is not an Endless mode backup.');
            if (obj.schema !== SCHEMA) throw new Error(`This backup has version ${obj.schema}; this page reads version ${SCHEMA}.`);
            if (!obj.items || typeof obj.items !== 'object' || Array.isArray(obj.items)) throw new Error('The backup has no progress in it.');
            return true;
        }
        function summary(obj) {
            validate(obj);
            const states = Object.values(obj.items);
            return { items: states.length, mastered: states.filter(s => s && s.grad !== null && s.grad !== undefined).length,
                     answers: (obj.log || []).length, exportedAt: obj.exportedAt };
        }

        // Replaces this device's progress with the file's. Keeps this device's id.
        async function importAll(obj) {
            validate(obj);
            const m = await meta();
            await backend.clear(true);
            await backend.putItems(obj.items);
            await backend.setLog(Array.isArray(obj.log) ? obj.log : []);
            const fm = obj.meta || {};
            const next = Object.assign({}, m, {
                baseline: Array.isArray(fm.baseline) ? fm.baseline : [],
                answerCount: typeof fm.answerCount === 'number' ? fm.answerCount : 0,
                typoLastAt: typeof fm.typoLastAt === 'number' ? fm.typoLastAt : null,
                W: typeof fm.W === 'number' ? fm.W : 6,
                accWindow: Array.isArray(fm.accWindow) ? fm.accWindow : [],
            });
            metaCache = next;
            await backend.putMeta(next);
        }

        async function reset() {
            await backend.clear(false);
            metaCache = null;
            await meta();
        }

        return { load, saveAnswer, saveMeta, getLog, exportAll, importAll, summary, validate, reset, backend };
    }

    async function local() {
        const idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
        if (idb) {
            try { return create(idbBackend(await openIdb(idb))); } catch (e) { /* fall back below */ }
        }
        const b = storageBackend(window.localStorage);
        b.warnings.push('This browser would not open IndexedDB, so progress is saved in localStorage (smaller). Export a backup now and then.');
        return create(b);
    }

    return {
        SCHEMA, FORMAT, LOG_KEEP, DB_NAME, PREFIX, uuid, memoryStorage, create,
        storageBackend, idbBackend, openIdb, local,
        memory: () => create(storageBackend(memoryStorage())),
        fromStorage: storage => create(storageBackend(storage)),
    };
}));
