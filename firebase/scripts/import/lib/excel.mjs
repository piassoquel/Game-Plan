// Helpers for values coming out of the GamePlan CMS workbook.

const LA_TZ = "America/Los_Angeles";

/** Offset in minutes to ADD to UTC to reach LA local time (negative, west). */
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

/**
 * Excel serial date -> JS Date. Apps Script wrote these as America/Los_Angeles
 * wall-clock values, so we preserve those wall-clock components in LA time.
 */
export function excelSerialToDate(serial) {
  if (serial === "" || serial == null) return null;
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const naiveMs = Math.round((n - 25569) * 86400 * 1000); // as if the wall-clock were UTC
  const off = laOffsetMinutes(new Date(naiveMs));
  return new Date(naiveMs - off * 60000);
}

/** YYYY-MM-DD in America/Los_Angeles for a Date. */
export function laDateString(d) {
  if (!d) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

export const str = (v) => (v == null ? "" : String(v).trim());

export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const numOrNull = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Sheet booleans: 1 / "1" / "true" / true. */
export const bool = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(str(v));

/** Digits only, for phone dedupe keys. */
export const phoneDigits = (v) => str(v).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** "James [STF-001]" -> "James"; passes through anything else. */
export const actorName = (v) => str(v).replace(/\s*\[[^\]]+\]\s*$/, "").trim();
