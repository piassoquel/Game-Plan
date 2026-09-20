# Firestore rules hardening — gp* data is server-write only

**Goal:** only an Admin can change availability / pricing (and all other
GamePlan data) when going around the app. Nobody can write gp* from a browser.

## What was wrong
1. GamePlan's rule blocks let *any signed-in store user* write every gp*
   collection (pricing config, availability, blackout dates, roles, login
   accounts, jobs...).
2. The dashboard's final catch-all `match /{document=**}` gave every
   dashboard "manager" read/write on the whole project — including gp*.
   Rules are OR-ed, so tightening (1) alone would not have closed this.

## The change (`firestore.rules.MERGED-full`, diff vs `...dashboard-before`)
- gp* collections: `allow read: if gpStoreUser(); allow write: if false;`
- Catch-all becomes `match /{col}/{docPath=**}` with
  `isApprovedManager() && !col.matches('gp[A-Z].*')` — dashboard managers keep
  everything else, just not gp*.
- Writes still work for the app: they run in Cloud Functions (Admin SDK).
  A project Admin can still edit anything in the Firebase console.
- The GamePlan web app makes no client-side Firestore writes (verified).

## Status
Compiles (`firebase deploy --only firestore:rules --dry-run`). NOT yet applied
to the dashboard's canonical file or deployed — see the conversation.
Rollback: redeploy `firestore.rules.dashboard-before`.
