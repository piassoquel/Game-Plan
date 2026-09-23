import { createHash, randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export const db = () => getFirestore();

export const sha256hex = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");
export const newId = (prefix) => `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
export const phoneDigits = (v) => String(v || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
export const str = (v) => (v == null ? "" : String(v).trim());
export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// PIN hashes (server-only, in gpStaffSecrets):
//   v2$<salt>$<scrypt hex>   new PINs — deliberately slow to guess
//   v1$<salt>$<sha256 hex>   legacy (Apps Script era) — still verifies until the PIN is reset
export function newPinHash(pin) {
  const salt = randomBytes(16).toString("hex");
  return `v2$${salt}$${scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
}

export function pinMatchesHash(pin, storedValue) {
  const stored = str(storedValue).toLowerCase();
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length === 3 && parts[0] === "v2") {
    const want = Buffer.from(parts[2], "hex");
    const got = scryptSync(String(pin), parts[1], want.length || 32, { N: 16384, r: 8, p: 1 });
    return want.length === got.length && timingSafeEqual(want, got);
  }
  if (parts.length === 3 && parts[0] === "v1") {
    return sha256hex(`${parts[1]}:${pin}`) === parts[2];
  }
  return sha256hex(pin) === stored; // legacy unsalted
}

export function normalizedAddressKey(value) {
  return str(value).toLowerCase()
    .replace(/\b(united states|usa)\b/g, "")
    .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\broad\b/g, "rd")
    .replace(/\bdrive\b/g, "dr").replace(/\bboulevard\b/g, "blvd").replace(/\blane\b/g, "ln")
    .replace(/\bcourt\b/g, "ct").replace(/\bhighway\b/g, "hwy")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Just checks the caller is a signed-in, active GamePlan login. No PIN, no role. */
export async function requireAuthorizedLogin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const email = String(request.auth.token.email || "").toLowerCase();
  const loginSnap = await db().doc(`gpLoginAccounts/${email}`).get();
  if (!loginSnap.exists || loginSnap.data().active !== true) {
    throw new HttpsError("permission-denied", `This account is not authorized for GamePlan: ${email}`);
  }
  return { email, ...loginSnap.data() };
}

/**
 * Resolve who is performing an action.
 * - personal Google account -> that staff member (no PIN)
 * - shared device account   -> requires a valid pinToken from verifyPin
 * Returns { email, sharedAccount, staffId, displayName, roleId, roleName, permissions }.
 */
export async function resolveActor(request, { pinToken } = {}) {
  const login = await requireAuthorizedLogin(request);
  const email = login.email;
  const d = db();

  if (!login.sharedAccount) {
    const staff = await staffByLogin(email);
    const role = await roleFor(staff.roleId);
    return actor(email, false, staff, role);
  }

  // shared account -> PIN token required
  if (!str(pinToken)) throw new HttpsError("failed-precondition", "Employee PIN verification is required.");
  const tokSnap = await d.doc(`gpPinTokens/${pinToken}`).get();
  if (!tokSnap.exists) throw new HttpsError("failed-precondition", "Your PIN authorization expired. Enter it again.");
  const tok = tokSnap.data();
  if (str(tok.email).toLowerCase() !== email || tok.expiresAt.toMillis() < Date.now()) {
    await tokSnap.ref.delete().catch(() => {});
    throw new HttpsError("failed-precondition", "Your PIN authorization expired. Enter it again.");
  }
  const staff = await staffById(tok.staffId);
  const role = await roleFor(staff.roleId);
  return actor(email, true, staff, role);
}

function actor(email, sharedAccount, staff, role) {
  return {
    email,
    sharedAccount,
    staffId: staff.id,
    displayName: staff.displayName || email,
    roleId: staff.roleId,
    roleName: role.name || staff.roleId,
    permissions: role.permissions || {},
  };
}

export function requirePermission(actorObj, key, message) {
  if (!actorObj?.permissions?.[key]) {
    throw new HttpsError("permission-denied", message || "You do not have permission to perform this action.");
  }
}

export function actorLabel(a) {
  return a.staffId ? `${a.displayName} [${a.staffId}]` : a.displayName || a.email;
}

async function staffByLogin(email) {
  const snap = await db().collection("gpStaff")
    .where("loginEmail", "==", email).where("active", "==", true).get();
  if (snap.empty) throw new HttpsError("permission-denied", "No active staff profile for this account.");
  if (snap.size > 1) throw new HttpsError("failed-precondition", "More than one active staff profile for this account.");
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function staffById(id) {
  const s = await db().doc(`gpStaff/${id}`).get();
  if (!s.exists || s.data().active !== true) throw new HttpsError("failed-precondition", "That employee is inactive.");
  return { id: s.id, ...s.data() };
}
async function roleFor(roleId) {
  const r = await db().doc(`gpRoles/${roleId}`).get();
  return r.exists ? r.data() : { name: roleId, permissions: {} };
}
