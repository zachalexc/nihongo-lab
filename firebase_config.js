// Firebase web config for Endless mode cloud sync. It is public by design: the Firestore security rules
// (firestore.rules) are what protect each user's data.
// To switch sync on: Firebase console → Project settings → Your apps → the web app → "SDK setup and
// configuration" → Config, then replace the placeholder object below with the one shown there.
// While this is the placeholder, the Sign in button says "Cloud sync isn't set up yet".
window.NL_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCi6llqJxDwFMZZEFcLZ6vrIrt6UJVigJc',
    authDomain: 'nihongo-lab-b0819.firebaseapp.com',
    projectId: 'nihongo-lab-b0819',
    appId: '1:146880798536:web:f41b770235826c186b9d7d',
};
