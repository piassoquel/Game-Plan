# GamePlan → Firebase (branch: `firebase`)

Rebuild of the GamePlan delivery/installation app off Google Sheets + Apps Script
onto Firebase, for speed and offline support. The current production app (repo
root, `main` branch) is untouched and keeps running until cutover.

## Why

- **Speed** — the Apps Script backend re-reads ~15 sheets on every load. Firebase
  serves from a real database + local cache: instant after first load.
- **Offline** — Firestore offline persistence covers viewing jobs, editing jobs,
  status changes (incl. marking **Complete** offline), customer edits, and the
  pickup checklist. Photos/signatures use a small offline upload queue (Phase 4).
- **Live link to the Daily Dashboard** — GamePlan publishes a "today feed" of
  deliveries/pickups/builds the dashboard subscribes to in real time.

## Hosting decision

GamePlan lives **in the dashboard's Firebase project** (`daily-inventory-operations`),
not a separate project. One Google sign-in list for both apps; the dashboard
reads GamePlan's feed with no cross-project auth. Separation is preserved by:
different repos, a dedicated Hosting site (`gameplan`), its own Cloud Functions
codebase (`gameplan`), and its own `gp`-prefixed collections.

The canonical `firestore.rules` / `firestore.indexes.json` are **owned by the
dashboard project**. The copies here are GamePlan's *proposed additions* to merge
in — never deployed standalone from this repo.

## Layout

```
firebase/
  .firebaserc            project alias -> daily-inventory-operations
  firebase.json          emulators, functions codebase, hosting site
  firestore.rules        PROPOSED GamePlan rule blocks (merge into dashboard's)
  firestore.indexes.json GamePlan indexes (dashboard owns the feed index)
  web/                   the new PWA (Phase 2+)
  functions/             Cloud Functions codebase "gameplan" (Phase 3+)
  scripts/import/        one-time Sheet -> Firestore importer (Phase 1)
  docs/data-model.md     Firestore data model + field mapping + feed contract
```

## Phases

1. **Data model + import** — Firestore structure, security rules draft, import
   script; tested against the local emulator. *(in progress)*
2. **Read path** — Today / Schedule / History+search screens on Firestore with
   offline persistence; deployed to the `gameplan` Hosting site alongside the
   live app.
3. **Write path** — create job + pricing engine (reusable function), status
   changes incl. offline Complete, job details, customer edits + dedupe;
   auto-recalculating schedule block.
4. **Pickup inspection** — checklist, photos, signature capture on Storage +
   offline upload queue.
5. **Admin** — PIN/roles/staff management, audit log, and the pricing dashboard
   + live simulator (same pricing function as real quotes).
6. **Cutover** — crew moves over; the Apps Script app is retired.

## Local dev

```bash
cd firebase
npx firebase emulators:start
```

Nothing in this branch deploys to the live project without explicit sign-off.
