// Nihongo Lab service worker: the whole site works offline (installed to the home screen or not).
// - Precaches the app shell below on install, each URL with the exact ?v= string index.html uses.
// - Same-origin GET requests: network first (a new deploy is picked up on the next online load),
//   successful responses update the cache; offline, the cached copy is served.
// - Cross-origin requests and non-GET requests are passed through untouched (never cached).
// - Nothing under match/ (Kanji Match is a separate project).
// - The Firebase SDK (vendor/firebase/) is not precached: it is cached on first use (signed-in users only).
// - The JLPT word data (jlpt_words.json, jlpt_beyond.json) is not precached either (its adapter srs_content_jlpt.js is): it lives in its own cache
//   DATA_CACHE, which shell-cache cleanup never touches. Cache first for the exact URL including ?v= (a file
//   never changes under one ?v=); network on a miss; storing a new ?v= deletes the older ones of that file.
//   A data ?v= change needs no CACHE_VERSION bump.
// Bump CACHE_VERSION whenever a precached file's ?v= changes (test_srs.js checks the list against index.html).
'use strict';

const CACHE_VERSION = 10;
const CACHE = 'nl-shell-' + CACHE_VERSION;
const DATA_CACHE = 'nl-data';
const DATA_PATH = /\/jlpt_(words|beyond)\.json$/;
const PRECACHE = [
    './',
    'index.html',
    'style.css?v=1.19',
    'vendor/wanakana.min.js?v=5.3.1',
    'kb1_core.js?v=1.14',
    'kb1.js?v=1.9',
    'srs_core.js?v=2.6',
    'srs_content_kb.js?v=1.1',
    'srs_content_jlpt.js?v=1.1',
    'srs_store.js?v=2.3',
    'srs_sync.js?v=1.0',
    'firebase_config.js?v=1.1',
    'cloud_firebase.js?v=1.0',
    'endless.js?v=2.9',
    'app.js?v=1.16',
    'manifest.webmanifest?v=1.0',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/apple-touch-icon.png',
    'data.json',
    'sentence_data.json',
    'kb1.enc',
    'sentences_dev.enc',
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('nl-shell-') && k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.includes('/match/')) return;
    if (DATA_PATH.test(url.pathname)) { event.respondWith(dataResponse(req, url)); return; }
    event.respondWith(fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
    }).catch(() => caches.open(CACHE).then(c => c.match(req)).then(hit => {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.open(CACHE).then(c => c.match('./')).then(h => h || Response.error());
        return Response.error();
    })));
});

// JLPT word data: cache first per exact URL (with ?v=), then the network; a stored new version replaces the old ones.
async function dataResponse(req, url) {
    const cache = await caches.open(DATA_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
        await cache.put(req, res.clone());
        for (const old of await cache.keys()) {
            const u = new URL(old.url);
            if (u.pathname === url.pathname && old.url !== req.url) await cache.delete(old);
        }
    }
    return res;
}
