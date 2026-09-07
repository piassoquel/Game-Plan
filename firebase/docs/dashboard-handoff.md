# Handoff to the Daily Inventory Operations thread

Paste this into that thread. It covers everything GamePlan needs from the
dashboard project side.

---

## What GamePlan has done in `daily-inventory-operations`

- Registered a web app ("GamePlan", appId `…f50b45a22a56d8f546c3c7`) and a
  second Hosting site target `gameplan`.
- Loaded its data into **top-level `gp`-prefixed collections** + `gpConfig`
  (366 docs). Nothing under `stores/soquel/…` was touched.
- GamePlan will **not** deploy `firestore.rules` or `firestore.indexes.json` —
  the dashboard project owns both. GamePlan only deploys its own Hosting site
  and its own Functions codebase (`gameplan`).

## 1. Merge these blocks into the canonical `firestore.rules`

Add inside `match /databases/{database}/documents { … }`. `isApproved()` is your
existing `allowedUsers/{email}` helper — the feed read rule below depends on it.

```
// --- GamePlan gate: signed-in + on GamePlan's own allow-list -------------
// GamePlan staff mostly sign in through a shared device account and identify
// per-action with a PIN (enforced in GamePlan's Cloud Functions). The gate is
// allow-list membership, not domain match.
function gpStoreUser() {
  return request.auth != null
    && request.auth.token.email_verified == true
    && exists(/databases/$(database)/documents/gpLoginAccounts/$(request.auth.token.email))
    && get(/databases/$(database)/documents/gpLoginAccounts/$(request.auth.token.email)).data.active == true;
}

// --- GamePlan application data -----------------------------------------
match /gpJobs/{jobId} {
  allow read, create, update: if gpStoreUser();
  allow delete: if false;
  match /{document=**} { allow read, write: if gpStoreUser(); }
}
match /gpCustomers/{customerId} {
  allow read, create, update: if gpStoreUser();
  allow delete: if false;
  match /{document=**} { allow read, write: if gpStoreUser(); }
}
match /gpEquipmentTypes/{id}    { allow read, write: if gpStoreUser(); }
match /gpAccessConditions/{id}  { allow read, write: if gpStoreUser(); }
match /gpJobTypes/{id}          { allow read, write: if gpStoreUser(); }
match /gpProducts/{id}          { allow read, write: if gpStoreUser(); }
match /gpBrands/{id}            { allow read, write: if gpStoreUser(); }
match /gpBlackoutDates/{id}     { allow read, write: if gpStoreUser(); }
match /gpAvailabilityRules/{id} { allow read, write: if gpStoreUser(); }
match /gpConfig/{doc}           { allow read, write: if gpStoreUser(); }
match /gpRoles/{roleId}         { allow read, write: if gpStoreUser(); }
match /gpLoginAccounts/{email}  { allow read, write: if gpStoreUser(); }
match /gpStaff/{staffId}        { allow read, write: if gpStoreUser(); }
match /gpAudit/{id} {
  allow read, create: if gpStoreUser();
  allow update, delete: if false;
}

// --- Today feed consumed by the dashboard -----------------------------
// Written ONLY by GamePlan's Cloud Function via the Admin SDK (bypasses rules).
match /stores/soquel/deliveries/{id} {
  allow read: if isApproved();
  allow write: if false;
}
```

## 2. Add this composite index to `firestore.indexes.json`

Per your spec — the dashboard's `where("date","==",…) orderBy("scheduledAt")`
query needs it:

```json
{
  "collectionGroup": "deliveries",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "date", "order": "ASCENDING" },
    { "fieldPath": "scheduledAt", "order": "ASCENDING" }
  ]
}
```

## 3. Your DECISIONS — GamePlan's answers

1. **Same project** — yes.
2. **One collection with `kind`** — yes (`stores/soquel/deliveries/{id}`).
3. **Past-day docs** — GamePlan prunes feed docs ~14 days after their `date`.
   Note: a pending **build** and a **past-due unclosed** delivery/pickup roll
   their `date` forward to the current day until handled, so they stay on your
   "today" query until closed.
4. **`date`** — `YYYY-MM-DD` in `America/Los_Angeles`. Confirmed.
5. **Status vocab** — GamePlan emits `scheduled | done | cancelled` for v1.
   `en-route` / `in-progress` reserved (no live crew tracking yet); adding them
   later needs no contract change.

## 4. Deviations from the spec

- **Doc IDs are deterministic**, not `{autoId}`:
  `gp_<jobId>_delivery`, `gp_<jobId>_pickup`, `gp_<jobId>_build`. Re-syncs
  update in place instead of duplicating. Extra field `sourceJobId` = the
  GamePlan job id.
- `window`, `assignedToName`, `notes` are `null` in v1.
- `build` docs add `buildDueBy` (Timestamp) = appointment − 48h.

## 5. Action on your side

Remove `piasemployee@gmail.com` from `allowedUsers` if present — it's a retired
shared account. GamePlan already has it disabled; it shouldn't reach the
dashboard either.

## 6. Timing

The feed writer is a GamePlan Cloud Function shipping in GamePlan's Phase 3.
Until then `stores/soquel/deliveries/` stays empty — the rules and index above
are safe to add now (they just gate an empty path).

## Sample feed documents

```json
// stores/soquel/deliveries/gp_JOB-8F1C2A4E9B77_delivery
{ "kind": "delivery", "date": "2026-09-08",
  "scheduledAt": "<Timestamp 2026-09-08T09:00:00-07:00>", "window": null,
  "status": "scheduled", "customerName": "Dana Whitfield",
  "summary": "Treadmill + weight set", "itemCount": 2,
  "address": "812 Cliff Dr, Santa Cruz, CA 95060",
  "assignedToName": null, "notes": null, "sourceJobId": "JOB-8F1C2A4E9B77",
  "createdAt": "<serverTimestamp>", "updatedAt": "<serverTimestamp>" }

// stores/soquel/deliveries/gp_JOB-8F1C2A4E9B77_build
{ "kind": "build", "date": "2026-09-06", "scheduledAt": null, "window": null,
  "buildDueBy": "<Timestamp 2026-09-06T09:00:00-07:00>",
  "status": "scheduled", "customerName": "Dana Whitfield",
  "summary": "Treadmill assembly (new, in-box)", "itemCount": 1,
  "address": "In store", "assignedToName": null, "notes": null,
  "sourceJobId": "JOB-8F1C2A4E9B77",
  "createdAt": "<serverTimestamp>", "updatedAt": "<serverTimestamp>" }
```
