# GamePlan Firestore data model

Draft for Phase 1. Source of truth for the import script and the app rebuild.
Maps the 33-sheet CMS workbook + Apps Script logic onto Firestore.

## Principles

- **Top-level, `gp`-prefixed collections** in the shared `daily-inventory-operations`
  project. No collision with the dashboard's `stores/soquel/…` data.
- **Denormalize for reads.** Store `customerName`, `serviceAddress`, etc. on the
  job so a screen renders from one document. The old app re-joined ~6 sheets per
  job; we don't.
- **Server-authoritative writes.** Pricing, schedule-conflict checks, PIN/role
  approvals run in Cloud Functions (Phase 3), not trusted from the client.
- **IDs:** keep the old string IDs on import (`JOB-…`, `CUS-…`) as the document
  IDs so history and cross-references survive. New records use Firestore auto-IDs
  with the same prefix convention where practical.
- **Timestamps:** real Firestore `Timestamp`, not strings. A separate `date`
  string field (`YYYY-MM-DD`, America/Los_Angeles) is kept where day-level
  filtering matters.

## Collections

### `gpJobs/{jobId}`
The core record. One document per delivery/pickup job.

| field | type | notes / source |
|---|---|---|
| `jobNumber` | string | `Jobs.JobNumber` e.g. `GP-2026-0042` |
| `status` | string | `unscheduled` \| `scheduled` \| `completed` \| `cancelled` (from `Statuses`; "Quote" retired) |
| `jobType` | string | `delivery` \| `pickup` \| `delivery+pickup` (from `JobTypes`) |
| `customerId` | string | ref `gpCustomers` (denormalized fields below) |
| `customerName` | string | denormalized |
| `customerPhone` | string | denormalized, 10 digits |
| `serviceAddressId` | string | ref `gpCustomers/{id}/addresses` |
| `serviceAddress` | string | denormalized formatted address |
| `servicePlaceId` | string | Google Places ID (address-match / dedupe) |
| `scheduledAt` | Timestamp \| null | appointment start; null when unscheduled |
| `scheduledDate` | string \| null | `YYYY-MM-DD` LA-local of `scheduledAt` |
| `durationMinutes` | number | schedule block = drive + on-site (see Scheduling) |
| `route` | map | `{ provider, originAddress, roundTripMiles, outboundMinutes, returnMinutes, calculatedAt }` |
| `pricing` | map | full breakdown, see below |
| `finalTotal` | number | dollars, rounded |
| `pickupType` | string \| null | `trade-in` \| `disposal` |
| `pickupInspectionStatus` | string | `not-needed` \| `needed` \| `complete` |
| `hasBuildItems` | bool | any equipment needs in-store assembly |
| `allItemsBuilt` | bool | build progress rollup |
| `detailsStatus` | string | `needed` \| `complete` (used-item photos/models captured) |
| `internalNotes` | string | free text; piggyback markers etc. |
| `archived` | bool | **false** = in the day-to-day working set; **true** = history-only |
| `createdBy` / `createdAt` | string / Timestamp | |
| `updatedBy` / `updatedAt` | string / Timestamp | |

`pricing` map (mirror of the Apps Script quote math, kept for display + audit):
`baseTripCharge, mileageCharge, travelLaborCharge, usedItemDeliveryCharge,
assemblyCharge, disposalCharge, accessLaborCharge, tradeInPickupDiscount,
calculatedSubtotal, minimumChargeAdjustment, roundedTotal`.

#### `gpJobs/{jobId}/equipment/{lineId}`
From `JobEquipment`. `equipmentTypeId, equipmentTypeName, condition (new|used),
brand, model, productId, quantity, imageUrl, deliveryRequired, pickupRequired,
buildRequired, buildComplete, buildCompletedBy, buildCompletedAt, specialNotes,
sortOrder`.

#### `gpJobs/{jobId}/access/{lineId}`
From `JobAccess`. `accessConditionId, name, quantity, addedMinutes,
addedLaborCharge`.

#### `gpJobs/{jobId}/history/{eventId}`
From `JobHistory`. `eventType, description, previousValue, newValue, performedBy,
performedAt, source`. Append-only.

#### `gpJobs/{jobId}/pickupInspection/{inspectionId}`
From `PickupInspections` + `PickupInspectionItems` (embedded as an `items` array).
`pickupType, overallCondition, additionalNotes, customerName, signatureUrl,
completedBy, completedAt, issueCount, photoCount, items[]`. Each item:
`jobEquipmentId, responses{}, issueSummary, photoUrl, disassembled,
disassemblyNotes, notes`.

### `gpCustomers/{customerId}`
From `Customers`. `firstName, lastName, name (denorm), primaryPhone (10 digits,
the dedupe key), email, companyName, active, createdAt, updatedAt`.

#### `gpCustomers/{customerId}/addresses/{addressId}`
From `CustomerAddresses`. `label, formattedAddress, placeId (indexed —
address-match), latitude, longitude, accessNotes, isDefault, active`.

### Reference / config (seeded once from the workbook, editable via Phase 5 admin)

| collection | from sheet | key fields |
|---|---|---|
| `gpEquipmentTypes/{id}` | `EquipmentTypes` | `name, deliveryMinutes, pickupMinutes, assemblyMinutes, defaultCrewSize, defaultAssemblyCharge, defaultDisposalCharge, iconName, active, sortOrder` |
| `gpAccessConditions/{id}` | `AccessConditions` | `name, defaultMinutes, flatCharge, active, sortOrder` |
| `gpJobTypes/{id}` | `JobTypes` | `name, active, sortOrder` |
| `gpProducts/{id}` | `Products` | `equipmentTypeId, brandId, model, imageUrl, defaultCrewSize` |
| `gpBrands/{id}` | `Brands` | `name, active` |
| `gpBlackoutDates/{id}` | `BlackoutDates` | `startDate, endDate, reason, overrideAllowed` |
| `gpAvailabilityRules/{id}` | `AvailabilityRules` | `day, available, startTime, endTime, slotIntervalMinutes` |
| `gpConfig/pricing` | `Settings` (subset) | `laborRatePerEmployeeHour, vehicleRatePerMile, baseTripCharge, minimumServiceCharge, priceRoundingIncrement, usedItemDeliveryCharge, tradeInPickupDiscount` |
| `gpConfig/scheduling` | `Settings` (subset) | `storeAddress, confirmationBufferMinutes, tentativeExpirationHours, buildAlertHours, workingSetRetentionDays` |
| `gpRoles/{roleId}` | `Roles` | `name, permissions{ canCreateQuote, canCreateTentative, canApproveSchedule, canOverrideConflict, canOverridePrice, canOverrideDuration, canEditCMS }` |
| `gpLoginAccounts/{email}` | `LoginAccounts` | doc ID = lowercased Google email (the rules gate). `loginAccountId, sharedAccount (bool), active`. `piasemployee@gmail.com` imported as **`active: false`** so historical `performedBy` strings still resolve, but it cannot sign in. *(Also remove it from the dashboard's `allowedUsers` — flagged to that thread.)* |
| `gpStaff/{staffId}` | `StaffProfiles` | `displayName, loginEmail, roleId, pinEnabled, pinHash, pinSalt, active, legacyId`. **8** employees share `employee@playitagainsoquel.com` (incl. Parker Brown, moved off the retired gmail account); James, Andrew, Dustin Moore on personal Workspace logins |
| `gpAudit/{id}` | `StaffAuditLog` + `CustomerAuditLog` + future | `entity, entityId, action, oldValue, newValue, performedBy, performedAt` |

## Working set vs. history

- Screens **Today** and **Schedule** query `gpJobs where archived == false`.
- **History / customer lookup** queries `gpJobs where customerId == X`
  (ordered by `scheduledAt` desc) — no search infra needed for "show me this
  customer's past deliveries".
- A scheduled Cloud Function (Phase 3) sets `archived = true` on jobs that are
  `completed`/`cancelled` and older than `gpConfig/scheduling.workingSetRetentionDays`
  (default 30). The import sets `archived = true` for jobs already
  `completed`/`cancelled`; `scheduled`/`unscheduled` jobs stay in the working set
  so the live pipeline is populated at cutover.

## Scheduling / duration (unchanged formula + one improvement)

`durationMinutes = outboundMinutes + returnMinutes + Σ(equipment serviceMinutes ×
qty) + Σ(access addedMinutes)`.

- Travel = **store → site → store**, typical (non-traffic) drive time. Deliberate
  business rule (margin + reload backstop). Kept as-is.
- Assembly minutes are **not** in the block (new-in-box items are built at the
  store first).
- **New:** a Firestore trigger recomputes `route`, `pricing`, and
  `durationMinutes` whenever a job's address, equipment, or access lines change.
- Conflict check: single crew. New job's `[scheduledAt, scheduledAt+duration)`
  must not overlap another `scheduled` job; plus availability rules + blackout
  dates. "Piggyback" manager-approved overlaps retained.

## Daily Dashboard feed contract

GamePlan writes (server-side only, Admin SDK) to the dashboard's collection.

- **Path:** `stores/soquel/deliveries/{docId}` — one collection, `kind` field.
- **Doc IDs are deterministic:** `gp_<jobId>_delivery`, `gp_<jobId>_pickup`,
  `gp_<jobId>_build` — re-syncs update in place, never duplicate.
  *(Deviation from the spec's `{autoId}` — flagged to the dashboard thread.)*
- **Retention:** feed docs pruned ~14 days after their `date`. GamePlan keeps full
  history in `gpJobs`.

| field | value |
|---|---|
| `kind` | `delivery` \| `pickup` \| `build` |
| `date` | `YYYY-MM-DD`, America/Los_Angeles. delivery/pickup = local date of `scheduledAt`, **but** if the job is past its date and still `scheduled` (not closed), a daily function rolls `date` forward to today so it stays visible until closed. **build** = first appears 48h before the appointment, then rolls `date` forward the same way until the build is done or the appointment passes |
| `scheduledAt` | Timestamp of the appointment; for `build`, the appointment it's prepping for (dashboard may show it as context) |
| `buildDueBy` | (build only) Timestamp = appointment − 48h — when the build should be finished |
| `window` | `null` (GamePlan always has an exact time once scheduled) |
| `status` | `scheduled` \| `done` \| `cancelled` (v1). `en-route` / `in-progress` reserved |
| `customerName` | string |
| `summary` | one line from the equipment list, e.g. `"Treadmill + weight set"` |
| `itemCount` | sum of equipment quantities \| `null` |
| `address` | service address; `"In store"` for `build` |
| `assignedToName` | `null` (single crew, no per-person assignment in v1) |
| `notes` | `null` (internal notes not surfaced to the dashboard in v1) |
| `sourceJobId` | GamePlan `jobId` (new field, for traceability) |
| `createdAt` / `updatedAt` | `serverTimestamp` |

Read rule (merged into the dashboard's file): `allow read: if isApproved();
allow write: if false;`. Composite index `(date ASC, scheduledAt ASC)` — added by
the dashboard side.

### Sample feed documents

```json
// stores/soquel/deliveries/gp_JOB-8F1C2A4E9B77_delivery
{
  "kind": "delivery",
  "date": "2026-09-07",
  "scheduledAt": "<Timestamp 2026-09-07T09:00:00-07:00>",
  "window": null,
  "status": "scheduled",
  "customerName": "Dana Whitfield",
  "summary": "Treadmill + weight set",
  "itemCount": 2,
  "address": "812 Cliff Dr, Santa Cruz, CA 95060",
  "assignedToName": null,
  "notes": null,
  "sourceJobId": "JOB-8F1C2A4E9B77",
  "createdAt": "<serverTimestamp>",
  "updatedAt": "<serverTimestamp>"
}
```
```json
// stores/soquel/deliveries/gp_JOB-8F1C2A4E9B77_build
{
  "kind": "build",
  "date": "2026-09-07",
  "scheduledAt": null,
  "window": null,
  "status": "scheduled",
  "customerName": "Dana Whitfield",
  "summary": "Treadmill assembly (new, in-box)",
  "itemCount": 1,
  "address": "In store",
  "assignedToName": null,
  "notes": null,
  "sourceJobId": "JOB-8F1C2A4E9B77",
  "createdAt": "<serverTimestamp>",
  "updatedAt": "<serverTimestamp>"
}
```
```json
// stores/soquel/deliveries/gp_JOB-2D9E77A10C34_pickup
{
  "kind": "pickup",
  "date": "2026-09-07",
  "scheduledAt": "<Timestamp 2026-09-07T11:30:00-07:00>",
  "window": null,
  "status": "scheduled",
  "customerName": "Marco Reyes",
  "summary": "Elliptical (trade-in)",
  "itemCount": 1,
  "address": "1140 41st Ave, Capitola, CA 95010",
  "assignedToName": null,
  "notes": null,
  "sourceJobId": "JOB-2D9E77A10C34",
  "createdAt": "<serverTimestamp>",
  "updatedAt": "<serverTimestamp>"
}
```

## Import data-quality cleanup (from `GamePlan CMS (current090726).xlsx`)

Real data is small: ~26 jobs, ~17 customers, ~37 equipment lines, ~125 history
events, 3 pickup inspections, 24 products. The whole working set + full history
caches offline with room to spare.

The importer normalizes:
- **Staff ID prefixes** — mix of `STF-` and `SFT-`. Normalize to `STF-`.
- **Colliding staff IDs** — `STF-008` (Parker Brown) vs `SFT-008` (Emily) both
  exist. Assign fresh sequential IDs, keep the original in `legacyId`.
- **`LoginAccounts.CreatedAt/UpdatedAt`** — several blank. Backfill with import
  timestamp; not load-bearing.
- **Two Dustins (confirmed two people):** `STF-003` → **Dustin Moore** (Manager,
  personal login `dustin@playitagainsoquel.com`); `SFT-009` → **Dustin Van Zandt**
  (Employee, shared `employee@playitagainsoquel.com`). Import sets full display
  names; the sheet has both as just "Dustin".
- **Parker Brown** — repoint `loginEmail` from `piasemployee@gmail.com` to the
  shared `employee@playitagainsoquel.com`.

## Answered

- Hosting: shared project `daily-inventory-operations`, `gp`-prefixed collections.
- Statuses: `unscheduled` / `scheduled` / `completed` / `cancelled` (Quote retired).
- Auth: **shared device accounts + per-person PINs stay.** Gate = `gpLoginAccounts`
  allow-list; PIN/role checks are server-side (Phase 3).
  `piasemployee@gmail.com` disabled everywhere.
- Two Dustins = two people (Moore / Van Zandt). Parker Brown → shared account.
- History import: everything, marked `archived: true`. Imported jobs keep the
  sheet's stored `durationMinutes` and `pricing` verbatim — records, not live
  quotes. Only new/edited jobs use the recompute path.
- Historical photos: leave as Drive links; only new photos go to Storage.
- Schedule block formula unchanged; add auto-recompute on job edits.
- Build feed: appears 48h before the appointment in **both** apps, stays on
  "today" until the build is marked done or the appointment passes.
