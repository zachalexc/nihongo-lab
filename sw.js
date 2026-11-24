// Nihongo Lab service worker: the whole site works offline (installed to the home screen or not).
// - Precaches the app shell below on install, each URL with the exact ?v= string index.html uses.
// - Same-origin GET requests: network first (a new deploy is picked up on the next online load),
//   successful responses update the cache; offline, the cached copy is served.
// - Cross-origin requests and non-GET requests are passed through untouched (never cached).
// - Nothing under match/ (Kanji Match is a separate project).
// Bump CACHE_VERSION whenever a precached file's ?v= changes (test_srs.js checks the list against index.html).
'use strict';

const CACHE_VERSION = 2;
const CACHE = 'nl-shell-' + CACHE_VERSION;
const PRECACHE = [
    './',
    'index.html',
    'style.css?v=1.16',
    'vendor/wanakana.min.js?v=5.3.1',
    'kb1_core.js?v=1.14',
    'kb1.js?v=1.9',
    'srs_core.js?v=2.2',
    'srs_content_kb.js?v=1.0',
    'srs_store.js?v=2.1',
    'endless.js?v=2.2',
    'app.js?v=1.15',
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
