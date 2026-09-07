# GamePlan CMS → Firestore importer

One-time load of the Google Sheet CMS into the new `gp*` Firestore collections
in the `daily-inventory-operations` project. Idempotent: doc IDs are stable
(legacy IDs / name slugs), so re-running overwrites rather than duplicating.

## Install

```bash
cd firebase/scripts/import
npm install
```

## Dry run (no writes)

```bash
npm run dry            # uses ~/Downloads/GamePlan CMS (current090726).xlsx
# or: node import.mjs --dry --file "/path/to/CMS.xlsx"
```

Writes `data/firestore.json` (gitignored) — every document grouped by collection
path, for review. Prints a per-collection count table.

## Production load

Needs a service account key (Firebase console → Project settings → Service
accounts → Generate new private key). Save as `serviceAccount.json` here
(gitignored) and:

```bash
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json npm run load:prod
```

Only touches `gp*` collections + `gpConfig`. Never reads or writes the
dashboard's `stores/soquel/...` data. Delete the key file when finished.

## What it does with known data-quality issues

- Staff IDs (`STF-`/`SFT-` mix, `STF-008` collision) → docs keyed by name slug;
  original ID kept as `legacyId`.
- Two Dustins → `Dustin Moore` (manager) and `Dustin Van Zandt` (employee).
- Parker Brown → moved onto `employee@playitagainsoquel.com`.
- `piasemployee@gmail.com` → imported `active: false` (cannot sign in).
- All imported jobs → `archived: true`, stored pricing/duration kept verbatim.
- Excel serial dates → `Timestamp`, interpreted as America/Los_Angeles.
