// Kanji Match: the Firebase side of sign-in and sync (R5, match-plan decision 10). Same Firebase project
// and Google sign-in as Endless (same origin, so one sign-in covers both tabs), but Match's own code:
// it never loads Endless's cloud_firebase.js or srs_sync.js.
// The vendored SDK (../vendor/firebase/13.4.0, Firestore Lite) and ../firebase_config.js load only when
// the user taps Sign in or was signed in before, so signed-out users download nothing extra.
// Adapter for match_sync.js: runTransaction(fn), fn gets { get(name), set(name, data) } on
// users/{uid}/match/{name}. Tests replace the whole backend with window.__matchCloudFake (same interface).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.MatchCloud = factory(root);
}(typeof self !== 'undefined' ? self : this, function (win) {
    'use strict';

    const SDK = '../vendor/firebase/13.4.0/';
    const CONFIG = '../firebase_config.js?v=1';
    const FLAG = 'nihongoMatch.cloud';         // '1' while signed in (outside the progress prefix, so Reset keeps it)
    const ENDLESS_FLAG = 'nlCloud';            // Endless's own flag: read only, so a sign-in there shows here
    let fb = null, auth = null, db = null, loading = null;
    const fake = () => win.__matchCloudFake || null;
    const ls = () => { try { return win.localStorage; } catch (e) { return null; } };

    function remembered() {
        const s = ls(); if (!s) return false;
        try { return s.getItem(FLAG) === '1' || s.getItem(ENDLESS_FLAG) === '1'; } catch (e) { return false; }
    }
    function remember(on) {
        const s = ls(); if (!s) return;
        try { if (on) s.setItem(FLAG, '1'); else s.removeItem(FLAG); } catch (e) { /* storage blocked */ }
    }

    function loadConfig() {
        if (win.NL_FIREBASE_CONFIG) return Promise.resolve();
        return new Promise((ok, fail) => {
            const s = win.document.createElement('script');
            s.src = CONFIG; s.onload = () => ok(); s.onerror = () => fail(new Error('Could not load the sign-in settings.'));
            win.document.head.appendChild(s);
        });
    }
    function configured() {
        if (fake()) return true;
        const c = win.NL_FIREBASE_CONFIG;
        return !!(c && c.apiKey && !/PASTE/.test(c.apiKey) && c.projectId);
    }

    // Load config + SDK once (dynamic import of the vendored ES modules).
    function ensure() {
        if (fake()) return Promise.resolve();
        if (!loading) {
            const base = new URL(SDK, win.document.baseURI).href;
            loading = loadConfig()
                .then(() => { if (!configured()) throw new Error("Cloud sync isn't set up yet."); })
                .then(() => Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'),
                                         import(base + 'firebase-firestore-lite.js')]))
                .then(([a, au, fs]) => {
                    fb = { a, au, fs };
                    // Reuse the default app if Endless code ever created it on this page.
                    const app = a.getApps().length ? a.getApp() : a.initializeApp(win.NL_FIREBASE_CONFIG);
                    auth = au.getAuth(app);
                    db = fs.getFirestore(app);
                })
                .catch(e => { loading = null; throw e; });
        }
        return loading;
    }

    const userOf = u => (u ? { uid: u.uid, email: u.email || '' } : null);

    async function signIn() {
        if (fake()) { const u = await fake().signIn(); remember(true); return u; }
        await ensure();
        if (auth.currentUser) { remember(true); return userOf(auth.currentUser); }
        const cred = await fb.au.signInWithPopup(auth, new fb.au.GoogleAuthProvider());
        remember(true);
        return userOf(cred.user);
    }
    async function signOut() {
        remember(false);
        if (fake()) return fake().signOut();
        await ensure();
        return fb.au.signOut(auth);
    }
    // cb(user | null): once at start-up with the remembered user, then after each change
    function onUser(cb) {
        if (fake()) return Promise.resolve(fake().onUser(cb));
        return ensure().then(() => fb.au.onAuthStateChanged(auth, u => cb(userOf(u))));
    }

    function adapter(uid) {
        if (fake()) return fake().adapter(uid);
        const ref = name => fb.fs.doc(db, 'users', uid, 'match', name);
        return {
            runTransaction: fn => fb.fs.runTransaction(db, async t => fn({
                async get(name) { const s = await t.get(ref(name)); return s.exists() ? s.data() : null; },
                set(name, data) { t.set(ref(name), data); },
            })),
        };
    }

    return { remembered, remember, configured, ensure, signIn, signOut, onUser, adapter,
             loaded: () => !!fb, FLAG };
}));
