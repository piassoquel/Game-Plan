// GamePlan Cloud Functions — codebase "gameplan" in daily-inventory-operations.
//
// Implemented: verifyPin, createJob.
// Next: calculateRoute (needs the Routes API key), updateJobStatus / completeJob,
//       recomputeJob trigger, publishTodayFeed.
//
// pricing.mjs is copied from web/js/pricing.mjs by the firebase.json predeploy
// hook so the wizard preview and server pricing stay identical.
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";

import {
  db, str, num, newId, phoneDigits, pinMatchesHash, normalizedAddressKey,
  requireAuthorizedLogin,
  resolveActor, requirePermission, actorLabel,
} from "./lib/common.mjs";
import { combineLocalDateTime, laDateString, assertNoConflict } from "./lib/schedule.mjs";
import { computeQuote } from "./pricing.mjs";

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const ROUTES_API_KEY = defineSecret("GOOGLE_MAPS_ROUTES_API_KEY");
const PIN_TTL_MS = 15 * 60 * 1000;

const MILES_PER_METER = 1 / 1609.344;

async function routeLeg(origin, destination, apiKey) {
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      units: "IMPERIAL",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.routes?.[0]) {
    throw new HttpsError("failed-precondition",
      `Google could not calculate this route. ${body.error?.message || res.statusText}`);
  }
  return {
    meters: num(body.routes[0].distanceMeters),
    seconds: Number(String(body.routes[0].duration || "0s").replace("s", "")) || 0,
  };
}

// ---------------------------------------------------------------- calculateRoute
export const calculateRoute = onCall({ secrets: [ROUTES_API_KEY] }, async (request) => {
  await requireAuthorizedLogin(request); // any signed-in store user; no PIN
  const destination = str(request.data?.destinationAddress);
  if (!destination) throw new HttpsError("invalid-argument", "A destination address is required.");

  const cfg = await db().doc("gpConfig/scheduling").get();
  const origin = str(cfg.exists && cfg.data().storeAddress);
  if (!origin) throw new HttpsError("failed-precondition", "Store address is not configured.");

  const apiKey = ROUTES_API_KEY.value();
  if (!apiKey) throw new HttpsError("failed-precondition", "Routes API key is not configured.");

  const [out, back] = await Promise.all([
    routeLeg(origin, destination, apiKey),
    routeLeg(destination, origin, apiKey),
  ]);
  const outboundTravelMinutes = Math.ceil(out.seconds / 60);
  const returnTravelMinutes = Math.ceil(back.seconds / 60);
  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    provider: "Google Routes",
    originAddress: origin,
    destinationAddress: destination,
    destinationPlaceId: str(request.data?.destinationPlaceId),
    oneWayDistanceMiles: round2(out.meters * MILES_PER_METER),
    roundTripDistanceMiles: round2((out.meters + back.meters) * MILES_PER_METER),
    outboundTravelMinutes,
    returnTravelMinutes,
    roundTripTravelMinutes: outboundTravelMinutes + returnTravelMinutes,
    calculatedAt: new Date().toISOString(),
  };
});

function employeeView(email, staff, role) {
  return {
    email,
    staffProfileId: staff.id,
    displayName: staff.displayName || email,
    roleId: staff.roleId,
    roleName: (role && role.name) || staff.roleId,
    permissions: (role && role.permissions) || {},
    sharedAccount: true,
    pinRequired: true,
  };
}

// ---------------------------------------------------------------- verifyPin
export const verifyPin = onCall(async (request) => {
  const pin = str(request.data?.pin);
  const requiredPermission = str(request.data?.requiredPermission);
  if (!/^\d{4,8}$/.test(pin)) throw new HttpsError("invalid-argument", "Enter your 4–8 digit PIN.");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");

  const email = String(request.auth.token.email || "").toLowerCase();
  const loginSnap = await db().doc(`gpLoginAccounts/${email}`).get();
  if (!loginSnap.exists || loginSnap.data().active !== true) {
    throw new HttpsError("permission-denied", "This account is not authorized for GamePlan.");
  }

  if (loginSnap.data().sharedAccount !== true) {
    // personal account — identity is the Google login; PIN not required.
    const s = await db().collection("gpStaff").where("loginEmail", "==", email).where("active", "==", true).get();
    if (s.empty) throw new HttpsError("permission-denied", "No active staff profile for this account.");
    const staff = { id: s.docs[0].id, ...s.docs[0].data() };
    const role = (await db().doc(`gpRoles/${staff.roleId}`).get()).data() || { permissions: {} };
    if (requiredPermission && !role.permissions?.[requiredPermission]) {
      throw new HttpsError("permission-denied", "You do not have permission to approve this action.");
    }
    return { token: "", expiresInSeconds: 900, employee: { ...employeeView(email, staff, role), sharedAccount: false, pinRequired: false } };
  }

  // shared account — match a PIN-enabled staff hash
  const candidates = await db().collection("gpStaff")
    .where("active", "==", true).where("pinEnabled", "==", true).get();
  const roleCache = {};
  const matches = [];
  for (const doc of candidates.docs) {
    const st = { id: doc.id, ...doc.data() };
    if (!st.pinHash || !pinMatchesHash(pin, st.pinHash)) continue;
    if (!roleCache[st.roleId]) {
      roleCache[st.roleId] = (await db().doc(`gpRoles/${st.roleId}`).get()).data() || { permissions: {} };
    }
    if (requiredPermission && !roleCache[st.roleId].permissions?.[requiredPermission]) continue;
    matches.push({ st, role: roleCache[st.roleId] });
  }
  if (!matches.length) {
    throw new HttpsError("permission-denied",
      requiredPermission ? "That PIN cannot approve this action." : "Incorrect PIN.");
  }
  if (matches.length > 1) {
    throw new HttpsError("failed-precondition", "This PIN is assigned to more than one employee. A manager must set unique PINs.");
  }

  const { st, role } = matches[0];
  const token = randomUUID().replace(/-/g, "");
  await db().doc(`gpPinTokens/${token}`).set({
    email, staffId: st.id, roleId: st.roleId, permissions: role.permissions || {},
    expiresAt: Timestamp.fromMillis(Date.now() + PIN_TTL_MS), createdAt: Timestamp.now(),
  });
  return { token, expiresInSeconds: 900, employee: employeeView(email, st, role) };
});

// ---------------------------------------------------------------- createJob
export const createJob = onCall(async (request) => {
  const d = db();
  const data = request.data || {};
  const now = Timestamp.now();
  const actor = await resolveActor(request, { pinToken: data.pinToken });
  requirePermission(actor, "canCreateQuote", "You do not have permission to create jobs.");

  const equipmentIn = Array.isArray(data.equipment) ? data.equipment : [];
  if (!equipmentIn.length) throw new HttpsError("invalid-argument", "At least one equipment item is required.");
  const route = data.route || {};
  if (!str(route.provider)) throw new HttpsError("failed-precondition", "Calculate the route before saving this job.");
  const addressText = str(data.address);
  if (!str(data.customerId) && (!str(data.firstName) || !phoneDigits(data.phone))) {
    throw new HttpsError("invalid-argument", "A new customer needs a first name and phone number.");
  }
  if (!str(data.addressId) && !addressText) {
    throw new HttpsError("invalid-argument", "Service address is required.");
  }

  const jobTypeId = str(data.jobTypeId) || "JT-DEL";
  const jt = await d.doc(`gpJobTypes/${jobTypeId}`).get();
  const jobTypeName = jt.exists ? jt.data().name : "Delivery";
  const kind = jt.exists ? (jt.data().kind || "delivery") : "delivery";
  const jobHasPickup = kind !== "delivery";
  let pickupType = str(data.pickupType).toLowerCase().replace(/\s+/g, "-") || null;
  if (pickupType === "sale") pickupType = "trade-in";
  if (jobHasPickup && !["trade-in", "disposal"].includes(pickupType)) {
    throw new HttpsError("invalid-argument", "Choose Trade-In or Disposal for the pickup.");
  }

  const [etSnap, acSnap, priceSnap, cfgSnap] = await Promise.all([
    d.collection("gpEquipmentTypes").get(),
    d.collection("gpAccessConditions").get(),
    d.doc("gpConfig/pricing").get(),
    d.doc("gpConfig/scheduling").get(),
  ]);
  const equipmentTypes = Object.fromEntries(etSnap.docs.map((x) => [x.id, x.data()]));
  const accessConditions = Object.fromEntries(acSnap.docs.map((x) => [x.id, x.data()]));
  const settings = priceSnap.exists ? priceSnap.data() : {};
  const storeAddress = (cfgSnap.exists && cfgSnap.data().storeAddress) || str(route.originAddress);

  const norm = (it) => ({
    equipmentTypeId: str(it.equipmentTypeId),
    condition: String(it.condition || "used").toLowerCase() === "new" ? "new" : "used",
    quantity: Math.max(1, num(it.quantity) || 1),
    deliveryRequired: it.movement ? it.movement === "delivery" : it.deliveryRequired !== false,
    pickupRequired: it.movement ? it.movement === "pickup" : it.pickupRequired === true,
    fulfillmentConditionId: str(it.fulfillmentConditionId) || "NIB",
  });
  const accessIn = (Array.isArray(data.access) ? data.access : [])
    .map((a) => (typeof a === "string" ? { accessConditionId: a, quantity: 1 } : a));

  const priced = computeQuote({
    equipment: equipmentIn.map(norm),
    access: accessIn,
    route: {
      roundTripMiles: num(route.roundTripDistanceMiles ?? route.roundTripMiles),
      outboundMinutes: num(route.outboundTravelMinutes ?? route.outboundMinutes),
      returnMinutes: num(route.returnTravelMinutes ?? route.returnMinutes),
    },
    pickupType, equipmentTypes, accessConditions, settings,
  });

  // ---- customer (dedupe by 10-digit phone) ----
  let customerId = str(data.customerId);
  let createCustomer = null;
  if (!customerId) {
    const digits = phoneDigits(data.phone);
    const dup = await d.collection("gpCustomers")
      .where("primaryPhone", "==", digits).where("active", "==", true).limit(1).get();
    if (!dup.empty) {
      customerId = dup.docs[0].id;
    } else {
      customerId = newId("CUS");
      createCustomer = {
        firstName: str(data.firstName), lastName: str(data.lastName),
        name: [str(data.firstName), str(data.lastName)].filter(Boolean).join(" ") || str(data.firstName),
        companyName: "", primaryPhone: digits, primaryPhoneDisplay: str(data.phone),
        secondaryPhone: "", email: str(data.email), preferredContact: str(data.email) ? "Email" : "Phone",
        generalNotes: "", active: true, createdAt: now, updatedAt: now,
      };
    }
  } else if (!(await d.doc(`gpCustomers/${customerId}`).get()).exists) {
    throw new HttpsError("not-found", "Selected customer no longer exists.");
  }

  // ---- address (reuse/create under the customer) ----
  let addressId = str(data.addressId);
  let createAddress = null;
  if (!addressId) {
    const placeId = str(data.destinationPlaceId || route.destinationPlaceId);
    const key = normalizedAddressKey(addressText);
    const existing = await d.collection(`gpCustomers/${customerId}/addresses`).where("active", "==", true).get();
    const hit = existing.docs.find((x) => {
      const a = x.data();
      return (placeId && a.placeId === placeId) || normalizedAddressKey(a.formattedAddress) === key;
    });
    if (hit) addressId = hit.id;
    else {
      addressId = newId("ADR");
      createAddress = {
        label: "Service Address", formattedAddress: addressText, placeId: placeId || null,
        latitude: null, longitude: null, accessNotes: "", isDefault: true, active: true, createdAt: now,
      };
    }
  }

  // ---- job number (transactional counter) ----
  const year = new Date().getFullYear();
  const jobNumber = await d.runTransaction(async (t) => {
    const ref = d.doc(`gpCounters/jobNumber-${year}`);
    const s = await t.get(ref);
    const next = (s.exists ? s.data().value : 0) + 1;
    t.set(ref, { value: next }, { merge: true });
    return `GP-${year}-${String(next).padStart(4, "0")}`;
  });

  // ---- optional scheduling (conflict-checked) ----
  let scheduledAt = null;
  let status = "unscheduled";
  if (str(data.scheduledDate) && str(data.scheduledTime)) {
    const when = combineLocalDateTime(data.scheduledDate, data.scheduledTime);
    await assertNoConflict(when, priced.durationMinutes, null, Boolean(data.overrideSchedule));
    scheduledAt = Timestamp.fromDate(when);
    status = "scheduled";
  }

  // ---- atomic write ----
  const jobId = newId("JOB");
  const batch = d.batch();
  if (createCustomer) batch.set(d.doc(`gpCustomers/${customerId}`), createCustomer);
  if (createAddress) batch.set(d.doc(`gpCustomers/${customerId}/addresses/${addressId}`), createAddress);

  const custName = createCustomer
    ? createCustomer.name
    : (await d.doc(`gpCustomers/${customerId}`).get()).data().name;
  const custPhone = createCustomer
    ? createCustomer.primaryPhone
    : (await d.doc(`gpCustomers/${customerId}`).get()).data().primaryPhone;
  const addrText = createAddress
    ? createAddress.formattedAddress
    : (await d.doc(`gpCustomers/${customerId}/addresses/${addressId}`).get()).data().formattedAddress;
  const addrPlace = createAddress
    ? createAddress.placeId
    : (await d.doc(`gpCustomers/${customerId}/addresses/${addressId}`).get()).data().placeId || null;

  batch.set(d.doc(`gpJobs/${jobId}`), {
    jobNumber, status, jobType: kind, jobTypeName, archived: false,
    customerId, customerName: custName, customerPhone: custPhone,
    serviceAddressId: addressId, serviceAddress: addrText, servicePlaceId: addrPlace,
    scheduledAt, scheduledDate: scheduledAt ? laDateString(scheduledAt.toDate()) : null,
    durationMinutes: priced.durationMinutes, crewSize: priced.crewSize,
    route: {
      provider: str(route.provider), originAddress: storeAddress, destinationAddress: addressText,
      roundTripMiles: priced.roundTripMiles,
      outboundMinutes: num(route.outboundTravelMinutes ?? route.outboundMinutes),
      returnMinutes: num(route.returnTravelMinutes ?? route.returnMinutes),
      status: "Calculated",
      calculatedAt: route.calculatedAt ? Timestamp.fromDate(new Date(route.calculatedAt)) : now,
    },
    pricing: priced.pricing, finalTotal: priced.finalTotal,
    pickupType, pickupNotes: str(data.pickupNotes),
    pickupInspectionStatus: jobHasPickup ? "needed" : "not-needed",
    hasBuildItems: priced.hasBuildItems, allItemsBuilt: !priced.hasBuildItems,
    detailsStatus: "needed",
    internalNotes: str(data.internalNotes), customerNotes: "", isPiggyback: false,
    createdBy: actorLabel(actor), createdAt: now, updatedBy: actorLabel(actor), updatedAt: now,
  });

  equipmentIn.forEach((it, i) => {
    const n = norm(it);
    const buildRequired = n.deliveryRequired && n.condition === "new" && n.fulfillmentConditionId === "NIB";
    batch.set(d.doc(`gpJobs/${jobId}/equipment/${newId("JEQ")}`), {
      equipmentTypeId: n.equipmentTypeId, condition: n.condition,
      brand: str(it.brand), model: str(it.model), itemDescription: str(it.notes) || str(it.model),
      productId: str(it.productId) || null, quantity: n.quantity, imageUrl: str(it.imageUrl),
      deliveryRequired: n.deliveryRequired, pickupRequired: n.pickupRequired,
      buildRequired, buildComplete: !buildRequired,
      calculatedServiceMinutes: 0, minimumCrewSize: num((equipmentTypes[n.equipmentTypeId] || {}).defaultCrewSize) || 1,
      specialNotes: str(it.notes), sortOrder: i + 1, active: true,
      createdBy: actorLabel(actor), createdAt: now,
    });
  });

  for (const a of accessIn) {
    const id = str(a.accessConditionId);
    const qty = Math.max(1, num(a.quantity) || 1);
    const cond = accessConditions[id] || {};
    batch.set(d.doc(`gpJobs/${jobId}/access/${newId("JAC")}`), {
      accessConditionId: id, name: cond.name || id, quantity: qty,
      addedMinutes: num(cond.defaultMinutes) * qty, addedLaborCharge: num(cond.flatCharge) * qty,
      notes: "", active: true, createdBy: actorLabel(actor), createdAt: now,
    });
  }

  batch.set(d.doc(`gpJobs/${jobId}/history/${newId("HIS")}`), {
    eventType: "Created", description: "Job created from GamePlan app",
    previousValue: "", newValue: status,
    performedBy: actorLabel(actor), performedAt: now, source: "GamePlan App",
  });

  await batch.commit();
  return {
    jobId, jobNumber, customerId, addressId, status,
    message: status === "scheduled" ? "Job scheduled" : "Quote created",
  };
});
