# Behavior fixes carried into the rebuild

Bugs / rough edges in the current Apps Script app that the Firebase version
should fix. Not new features — corrections to existing behavior.

## 1. A job can only be completed on its scheduled day

**Symptom:** a Scheduled job (especially a pickup) that wasn't closed out on the
day it was booked has no "Complete" button afterward — the only options are
Edit / Reschedule or Cancel. It's stuck as Scheduled forever, or you have to
reschedule it to today just to close it. Two real examples in the current data:
GP-2026-0009 (pickup, 2026-08-03) and GP-2026-0019 (pickup, 2026-08-24).

**Root cause** (`js/app.js`):
- `workflowActions()` only renders `✓ Complete Job` inside
  `if (job.status === "Scheduled" && today)`.
- `today` = `isTodayJob(job)` which requires
  `toDateKey(date) === toDateKey(new Date())` — the appointment date must equal
  the current date exactly. Any past (or future) date → no Complete button.
- For pickups it compounds: the Complete button is also disabled until the
  pickup inspection is finalized, and the inspection doesn't auto-complete the
  job — so even after finalizing a late pickup's inspection, the job can't be
  closed.

**Fix in the rebuild:**
- "Mark Complete" is available whenever `status === 'scheduled'` and
  `scheduledAt` is **today or earlier** (past-due included). Future-dated jobs
  hide it, or show it behind a "Complete early?" confirm.
- Pickups still require the pickup inspection to be finalized first (keeps the
  signature + condition record), but the inspection is reachable on any day the
  job is scheduled, not just the booked day.
- When a pickup inspection is finalized on a today-or-past job and nothing else
  is outstanding, offer "Finalize & Complete" as one action.
- All of this works offline: the Complete write queues; for pickups the
  inspection finalize + photo/signature uploads queue first (Phase 4 queue),
  then the Complete flag. On sync, the server re-checks the job was Scheduled
  and the inspection is done.

### 1b. Past-due unclosed jobs must raise an alert

A `scheduled` job whose local `scheduledAt` date is **before today** is
"past due — needs closing". The app must actively draw attention to it, not
let it scroll away:

- **Today screen** — a "Past due" band at the top (reuse the existing
  attention-rail treatment used for "details needed" / "schedule conflict"),
  listing each past-due job with its age ("3 days overdue") and a primary
  **Complete** action (plus Reschedule / Cancel).
- **Schedule screen** — past-due jobs render with a warning style and stay
  pinned/visible rather than falling off the bottom of past weeks.
- **Nav** — a count indicator so it's visible from any screen.
- **Daily Dashboard feed** — a past-due delivery/pickup rolls its feed `date`
  forward to the current day (same mechanism as pending builds) so it stays on
  the dashboard's "today" until closed. `status` stays `scheduled`.
- Threshold is date-based (`scheduledDate < todayLA`). A softer "still open at
  end of day" nudge for same-day jobs is optional, later.

## 2. Schedule block / price go stale after a job is edited

Editing a job's equipment, access conditions, or address does not recompute
`durationMinutes`, `route`, or `pricing` (`updateJobDetails_` never touches
them). The rebuild recomputes on any such change via a Firestore trigger.
See `data-model.md` → Scheduling.

## 3. (add as found)
