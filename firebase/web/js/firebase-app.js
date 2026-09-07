// Firebase bootstrap for GamePlan. Firestore is configured with a persistent
// local cache so every read the app has done once works offline and syncs on
// reconnect.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, SIGN_IN_HINT_DOMAIN } from "../firebase-config.js";

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ hd: SIGN_IN_HINT_DOMAIN, prompt: "select_account" });

export function signInWithGoogle() {
  return signInWithPopup(auth, provider);
}
export function signOutOfGoogle() {
  return signOut(auth);
}
export { onAuthStateChanged };
