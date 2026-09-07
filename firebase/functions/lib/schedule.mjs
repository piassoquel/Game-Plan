import { HttpsError } from "firebase-functions/v2/https";
import { db, num } from "./common.mjs";

const LA_TZ = "America/Los_Angeles";

function laOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** "YYYY-MM-DD" + "HH:mm" interpreted as America/Los_Angeles -> Date. */
export function combineLocalDateTime(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh, mm] = String(timeStr).split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
    throw new HttpsError("invalid-argument", "Invalid appointment date or time.");
  }
  const naiveMs = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off = laOffsetMinutes(new Date(naiveMs));
  return new Date(naiveMs - off * 60000);
}

export function laDateString(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/**
 * Single-crew scheduling guard. Rejects if [start, start+duration) overlaps
 * another scheduled job, unless `override` is set.
 * TODO(next): availability-rule window + blackout-date checks.
 */
export async function assertNoConflict(startDate, durationMinutes, excludeJobId, override) {
  const start = startDate.getTime();
  const end = start + Math.max(30, num(durationMinutes)) * 60000;
  const snap = await db().collection("gpJobs").where("status", "==", "scheduled").get();
  const clashes = [];
  for (const doc of snap.docs) {
    if (doc.id === excludeJobId) continue;
    const j = doc.data();
    if (!j.scheduledAt) continue;
    const oStart = j.scheduledAt.toMillis();
    const oEnd = oStart + Math.max(30, num(j.durationMinutes)) * 60000;
    if (start < oEnd && end > oStart) clashes.push(j.jobNumber || doc.id);
  }
  if (clashes.length && !override) {
    throw new HttpsError(
      "failed-precondition",
      `This time overlaps an approved job (${clashes.join(", ")}). A manager must approve the overlap.`,
    );
  }
  return clashes;
}
