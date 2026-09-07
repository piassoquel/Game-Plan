// Firebase bootstrap for GamePlan. Firestore is configured with a persistent
// local cache so every read the app has done once works offline and syncs on
// reconnect.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, SIGN_IN_HINT_DOMAIN } from "../firebase-config.js";

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});
// Completes a redirect sign-in (mobile); onAuthStateChanged fires afterward.
getRedirectResult(auth).catch(() => {});

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ hd: SIGN_IN_HINT_DOMAIN, prompt: "select_account" });

const REDIRECT_FALLBACK = new Set([
  "auth/popup-blocked",
  "auth/cancelled-popup-request",
  "auth/popup-closed-by-user",
  "auth/operation-not-supported-in-this-environment",
]);

// Popup on desktop; fall back to full-page redirect where popups don't work
// (most phones, installed PWAs).
export async function signInWithGoogle() {
  try {
    return await signInWithPopup(auth, provider);
  } catch (error) {
    if (REDIRECT_FALLBACK.has(error?.code)) {
      return signInWithRedirect(auth, provider);
    }
    throw error;
  }
}

export function signOutOfGoogle() {
  return signOut(auth);
}
export { onAuthStateChanged };
