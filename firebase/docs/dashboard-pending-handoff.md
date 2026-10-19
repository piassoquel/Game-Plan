# Handoff: "Pending approval" notifications for managers (Daily Dashboard thread)

GamePlan now publishes one doc per **Tentative delivery/pickup that has a
requested appointment and is waiting for manager confirmation**. This hands the
dashboard thread what it needs to show it to managers/admins only.

## What GamePlan already does (deployed)

- Collection: **`stores/soquel/gpPending/{id}`**, id = `gp_<jobId>_pending`.
- Written only by GamePlan's Cloud Function (Admin SDK). Kept in sync in real
  time with every job change, and re-checked daily at 05:00.
- A doc exists only while the job is **Tentative with a future requested
  time**. It is deleted automatically when the job is confirmed (Scheduled),
  cancelled, completed, archived, or its requested time passes.
- It is a **separate collection on purpose**: the dashboard's Today query on
  `stores/soquel/deliveries` shows every doc to every user, employees
  included. Pending approvals must not appear there.

Sample doc:

```json
// stores/soquel/gpPending/gp_JOB-8F1C2A4E9B77_pending
{ "status": "pending",
  "jobType": "delivery+pickup",          // delivery | pickup | delivery+pickup
  "date": "2026-10-23",                  // YYYY-MM-DD, America/Los_Angeles
  "requestedAt": "<Timestamp 2026-10-23T10:00:00-07:00>",
  "customerName": "Dana Whitfield",
  "summary": "Recumbent Bike (new) + Treadmill",
  "itemCount": 2,
  "address": "812 Cliff Dr, Santa Cruz, CA 95060",
  "needsDetails": true,                  // equipment model/photos still missing
  "createdByName": "Parker Brown",
  "jobCreatedAt": "<Timestamp>",
  "sourceJobId": "JOB-8F1C2A4E9B77",
  "updatedAt": "<serverTimestamp>" }
```

## 1. Rules block to add to `firestore.rules`

Managers only. `isApprovedManager()` already exists. Place it next to the
`stores/soquel/deliveries` rule:

```
// Tentative deliveries/pickups awaiting manager approval. Written ONLY by
// GamePlan's Cloud Function (Admin SDK). Managers/admins only — employees
// never see pending approvals.
match /stores/soquel/gpPending/{id} {
  allow read: if isApprovedManager();
  allow write: if false;
}
```

No new index is needed if the dashboard reads the whole collection (it is
small — only open Tentative jobs) and sorts client-side by `requestedAt`.

## 2. What the dashboard should show (managers only)

Only when `state.userRole === "manager"` (GamePlan Admin and Manager both map
to the dashboard's manager role). Never subscribe for employees.

1. **A subscription** `onSnapshot(collection(db,"stores","soquel","gpPending"))`
   started only for managers.
2. **Manager home → "Needs you" inbox**: one card per pending doc, e.g.
   tag "Pending approval", title `"<customerName> — <Delivery|Pickup|Delivery + Pickup>"`,
   sub `"<requested date/time> · <summary>"`, plus a line "Equipment details
   still needed" when `needsDetails` is true. Primary action opens GamePlan
   (`https://gameplan-soquel.web.app/#today`, same as the existing Deliveries tile).
3. **Deliveries & Builds tile badge** (or a second small badge): count of
   pending docs, in a warning colour so it reads differently from the navy
   "today" count. Keep the tile line honest, e.g. "2 awaiting approval".
4. **Toast** for managers when a *new* pending doc appears (not on first load):
   `GamePlan: new delivery awaiting approval — <customerName>`. Reuse the
   `notify` pattern already used for new deliveries in `today.mjs`.
5. **Today callout** (`firstThings()` in `today.mjs`): add a manager-only entry
   "Pending approvals" so it surfaces in the top callout carousel.

The cards disappear on their own when GamePlan confirms or cancels the job.
The dashboard never writes to this collection.

## Notes

- Managers can confirm from GamePlan only after the equipment details are
  complete (server-enforced), which is why `needsDetails` is worth showing.
- Docs for jobs that existed before this shipped appear the next time the job
  changes or at the 05:00 daily sync, whichever comes first.
