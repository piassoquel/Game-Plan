// Public Firebase config for the GamePlan web app.
// Not a secret: Firebase access is controlled by security rules, not by hiding
// this. Safe to commit and to serve to browsers.
export const firebaseConfig = {
  apiKey: "AIzaSyA2RvsEkb8hpRAMQMRwxpDH_PffLroyfws",
  authDomain: "daily-inventory-operations.firebaseapp.com",
  projectId: "daily-inventory-operations",
  storageBucket: "daily-inventory-operations.firebasestorage.app",
  messagingSenderId: "97168737478",
  appId: "1:97168737478:web:f50b45a22a56d8f546c3c7",
};

// Google sign-in shows the Workspace domain as a hint (`hd` param), but the
// real gate is the gpLoginAccounts allow-list in Firestore — one shared account
// is a gmail.com address, so we can't hard-restrict by domain.
export const SIGN_IN_HINT_DOMAIN = "playitagainsoquel.com";
