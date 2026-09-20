import { HttpsError } from "firebase-functions/v2/https";
import { db, num, str } from "./common.mjs";

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

function laParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ, weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, minutes: (+p.hour % 24) * 60 + +p.minute };
}
const hmToMinutes = (v) => {
  const [h, m] = str(v).split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

const dur = (minutes) => Math.max(30, num(minutes)) * 60000;

/** Scheduled jobs whose interval overlaps [start, start+duration). Returns docs. */
export async function overlappingScheduledJobs(startDate, durationMinutes, excludeJobId) {
  const start = startDate.getTime();
  const end = start + dur(durationMinutes);
  const snap = await db().collection("gpJobs").where("status", "==", "scheduled").get();
  return snap.docs.filter((doc) => {
    if (doc.id === excludeJobId) return false;
    const j = doc.data();
    if (!j.scheduledAt) return false;
    const oStart = j.scheduledAt.toMillis();
    return start < oStart + dur(j.durationMinutes) && end > oStart;
  });
}

/**
 * Availability-rule window + blackout-date check.
 * Returns { soft: [...], hard: [...] } human-readable reasons:
 *  - soft  = needs a manager override (weekend/off-day, outside hours,
 *            blackout with overrides allowed)
 *  - hard  = closed to everyone (blackout or off-day with overrideAllowed=false)
 */
export async function schedulabilityReasons(startDate) {
  const { weekday, minutes } = laParts(startDate);
  const dateKey = laDateString(startDate);
  const soft = [];
  const hard = [];

  const [rulesSnap, blackoutSnap] = await Promise.all([
    db().collection("gpAvailabilityRules").get(),
    db().collection("gpBlackoutDates").get(),
  ]);

  const rule = rulesSnap.docs.map((x) => x.data())
    .find((r) => str(r.day).toLowerCase().startsWith(weekday.toLowerCase().slice(0, 3)));
  if (rule) {
    if (rule.active === false || rule.available === false) {
      const msg = `${weekday} is outside normal delivery days`;
      (rule.overrideAllowed === true ? soft : hard).push(msg);
    } else {
      const open = hmToMinutes(rule.startTime);
      const close = hmToMinutes(rule.endTime);
      if (open != null && minutes < open) soft.push("appointment is before normal hours");
      if (close != null && minutes > close) soft.push("appointment is after normal hours");
    }
  } else if (weekday === "Saturday" || weekday === "Sunday") {
    soft.push(`${weekday} requires manager discretion`);
  }

  for (const b of blackoutSnap.docs.map((x) => x.data())) {
    if (b.active === false) continue;
    const from = str(b.startDate) || str(b.endDate);
    const to = str(b.endDate) || str(b.startDate);
    if (from && dateKey >= from && dateKey <= to) {
      const msg = `blackout${b.reason ? `: ${b.reason}` : ""}`;
      (b.overrideAllowed === false ? hard : soft).push(msg);
    }
  }
  return { soft, hard };
}

/**
 * Guard used when a job takes a time slot. Throws for hard blocks always;
 * for overlaps unless `override`; for soft policy reasons unless `override`
 * or `policyOverride` (a caller who may override availability rules).
 * Returns { overlaps: [jobNumber...], reasons: [...] } (the overridden ones).
 */
export async function assertSchedulable(startDate, durationMinutes, excludeJobId, override, policyOverride = false) {
  const [overlapDocs, { soft, hard }] = await Promise.all([
    overlappingScheduledJobs(startDate, durationMinutes, excludeJobId),
    schedulabilityReasons(startDate),
  ]);
  if (hard.length) {
    throw new HttpsError("failed-precondition", `Closed to deliveries: ${hard.join("; ")}. Choose another date.`);
  }
  const overlaps = overlapDocs.map((d) => d.data().jobNumber || d.id);
  if (overlaps.length && !override) {
    throw new HttpsError("failed-precondition",
      `Manager override required: overlaps an approved job (${overlaps.join(", ")}).`);
  }
  if (soft.length && !(override || policyOverride)) {
    throw new HttpsError("failed-precondition", `Manager override required: ${soft.join("; ")}.`);
  }
  return { overlaps, reasons: soft };
}
