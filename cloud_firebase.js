// Endless mode: the Firebase side of cloud sync (phase 3). Loads the vendored SDK (vendor/firebase/13.4.0,
// modular builds, Firestore Lite) only when the user taps Sign in or was signed in before (localStorage
// nlCloud = '1'), so signed-out users download nothing extra. Provides sign-in and the adapter srs_sync.js
// uses: runTransaction(fn) with get/set/delete on users/{uid}/srs/{name}.
// Tests replace the whole backend with window.__nlCloudFake (same interface), so no network is needed.
window.NLCloud = (function () {
    'use strict';

    const SDK = './vendor/firebase/13.4.0/';
    let fb = null, app = null, auth = null, db = null, loading = null;
    const fake = () => window.__nlCloudFake || null;

    function configured() {
        if (fake()) return true;
        const c = window.NL_FIREBASE_CONFIG;
        return !!(c && c.apiKey && !/PASTE/.test(c.apiKey) && c.projectId);
    }

    // Load the SDK once (dynamic import of the vendored ES modules).
    function ensure() {
        if (fake()) return Promise.resolve();
        if (!loading) {
            loading = Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore-lite.js')])
                .then(([a, au, fs]) => {
                    fb = { a, au, fs };
                    app = a.initializeApp(window.NL_FIREBASE_CONFIG);
                    auth = au.getAuth(app);
                    db = fs.getFirestore(app);
                })
                .catch(e => { loading = null; throw e; });
        }
        return loading;
    }

    const userOf = u => (u ? { uid: u.uid, email: u.email || '' } : null);

    async function signIn() {
        if (fake()) return fake().signIn();
        await ensure();
        const cred = await fb.au.signInWithPopup(auth, new fb.au.GoogleAuthProvider());
        return userOf(cred.user);
    }
    async function signOut() {
        if (fake()) return fake().signOut();
        await ensure();
        return fb.au.signOut(auth);
    }
    // cb(user | null), called once at start-up with the remembered user, and after each change
    function onUser(cb) {
        if (fake()) return fake().onUser(cb);
        return ensure().then(() => fb.au.onAuthStateChanged(auth, u => cb(userOf(u))));
    }

    // The adapter for srs_sync.js
    function adapter(uid) {
        if (fake()) return fake().adapter(uid);
        const ref = name => fb.fs.doc(db, 'users', uid, 'srs', name);
        return {
            runTransaction: fn => fb.fs.runTransaction(db, async t => fn({
                async get(name) { const s = await t.get(ref(name)); return s.exists() ? s.data() : null; },
                set(name, data) { t.set(ref(name), data); },
                delete(name) { t.delete(ref(name)); },
            })),
        };
    }

    return { configured, ensure, signIn, signOut, onUser, adapter, loaded: () => !!fb };
})();
