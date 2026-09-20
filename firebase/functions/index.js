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
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";

import {
  db, str, num, newId, phoneDigits, pinMatchesHash, normalizedAddressKey,
  requireAuthorizedLogin,
  resolveActor, requirePermission, actorLabel,
} from "./lib/common.mjs";
import {
  combineLocalDateTime, laDateString, assertSchedulable, overlappingScheduledJobs, schedulabilityReasons,
} from "./lib/schedule.mjs";
import { syncJobFeed, pruneFeed } from "./lib/feed.mjs";
import { uploadDataUrl } from "./lib/photos.mjs";
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
  const [candidates, secretsSnap] = await Promise.all([
    db().collection("gpStaff").where("active", "==", true).where("pinEnabled", "==", true).get(),
    db().collection("gpStaffSecrets").get(), // server-only: PIN hashes never live in client-readable docs
  ]);
  const hashById = Object.fromEntries(secretsSnap.docs.map((x) => [x.id, x.data().pinHash]));
  const roleCache = {};
  const matches = [];
  for (const doc of candidates.docs) {
    const st = { id: doc.id, ...doc.data() };
    const storedHash = hashById[doc.id];
    if (!storedHash || !pinMatchesHash(pin, storedHash)) continue;
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
    const { overlaps, reasons } = await assertSchedulable(
      when, priced.durationMinutes, null, Boolean(data.overrideSchedule),
      Boolean(actor.permissions?.canOverrideConflict));
    if (overlaps.length || reasons.length) {
      requirePermission(actor, "canOverrideConflict", "This user cannot override schedule restrictions.");
    }
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

  const jobEquipmentIds = [];
  equipmentIn.forEach((it, i) => {
    const n = norm(it);
    const buildRequired = n.deliveryRequired && n.condition === "new" && n.fulfillmentConditionId === "NIB";
    const lineId = newId("JEQ");
    jobEquipmentIds.push(lineId);
    batch.set(d.doc(`gpJobs/${jobId}/equipment/${lineId}`), {
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
    jobId, jobNumber, customerId, addressId, status, jobEquipmentIds,
    message: status === "scheduled" ? "Job scheduled" : "Quote created",
  };
});

// ------------------------------------------------------------- updateJobStatus
const UI_TO_ENUM = { Scheduled: "scheduled", Completed: "completed", Cancelled: "cancelled", Tentative: "unscheduled" };
const VALID_NEXT = {
  unscheduled: ["scheduled", "cancelled"],
  scheduled: ["completed", "cancelled", "unscheduled"],
  completed: [],
  cancelled: [],
};

export const updateJobStatus = onCall(async (request) => {
  const d = db();
  const data = request.data || {};
  const now = Timestamp.now();
  const jobId = str(data.jobId);
  const target = UI_TO_ENUM[str(data.newStatus)] || str(data.newStatus).toLowerCase();
  if (!jobId) throw new HttpsError("invalid-argument", "jobId is required.");
  if (!["scheduled", "completed", "cancelled", "unscheduled"].includes(target)) {
    throw new HttpsError("invalid-argument", `Unsupported status: ${data.newStatus}`);
  }

  const actor = await resolveActor(request, { pinToken: data.pinToken });
  requirePermission(actor, "canCreateQuote", "You do not have permission to change job status.");

  const ref = d.doc(`gpJobs/${jobId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Job not found.");
  const job = snap.data();
  const current = job.status;
  if (current === target) return { jobId, status: target, unchanged: true };

  if (!(VALID_NEXT[current] || []).includes(target)) {
    throw new HttpsError("failed-precondition", `Cannot change a ${current} job to ${target}.`);
  }

  // Manager approval for schedule-affecting changes.
  const managerOnly = target === "scheduled" ||
    (current === "scheduled" && ["cancelled", "unscheduled"].includes(target));
  let approver = null;
  if (managerOnly) {
    approver = actor.permissions?.canApproveSchedule
      ? actor
      : await resolveActor(request, { pinToken: data.approvalToken });
    requirePermission(approver, "canApproveSchedule", "Manager approval is required for this change.");
  }

  let pickupOverride = false;
  if (target === "completed") {
    const inspectionOutstanding = job.pickupInspectionStatus &&
      job.pickupInspectionStatus !== "not-needed" && job.pickupInspectionStatus !== "complete";
    if (inspectionOutstanding) {
      if (!data.overridePickupInspection) {
        throw new HttpsError("failed-precondition", "Finalize the pickup inspection before completing this job.");
      }
      const mgr = actor.permissions?.canApproveSchedule
        ? actor
        : await resolveActor(request, { pinToken: data.approvalToken });
      requirePermission(mgr, "canApproveSchedule", "A manager must approve completing a pickup without an inspection.");
      pickupOverride = true;
    }
  }

  let clashes = [];
  if (target === "scheduled") {
    if (!job.scheduledAt) throw new HttpsError("failed-precondition", "Give this job a date and time before scheduling it.");
    const { overlaps, reasons } = await assertSchedulable(
      job.scheduledAt.toDate(), job.durationMinutes, jobId, Boolean(data.overrideSchedule),
      Boolean(approver?.permissions?.canOverrideConflict));
    clashes = [...overlaps, ...reasons];
    if (clashes.length) requirePermission(approver, "canOverrideConflict", "This manager cannot override schedule restrictions.");
  }

  const updates = { status: target, updatedBy: actorLabel(actor), updatedAt: now };
  if (target === "completed") updates.completedAt = now;
  if (target === "scheduled" && approver) { updates.approvedBy = actorLabel(approver); updates.approvedAt = now; }
  await ref.update(updates);

  await d.doc(`gpJobs/${jobId}/history/${newId("HIS")}`).set({
    eventType: "Status Changed",
    description: (str(data.statusNote) || `Status changed from ${current} to ${target}`) +
      (approver && approver !== actor ? ` · Approved by ${actorLabel(approver)}` : "") +
      (pickupOverride ? " · Completed without pickup inspection (manager override)" : "") +
      (clashes.length ? ` · Manager override: overlaps ${clashes.join(", ")}` : ""),
    previousValue: current, newValue: target,
    performedBy: actorLabel(actor), performedAt: now, source: "GamePlan App",
  });

  return {
    jobId, previousStatus: current, status: target,
    approvedBy: approver && approver !== actor ? actorLabel(approver) : "",
  };
});

// ----------------------------------------------- updateEquipmentBuildStatus
export const updateEquipmentBuildStatus = onCall(async (request) => {
  const d = db();
  const data = request.data || {};
  const now = Timestamp.now();
  const jobId = str(data.jobId);
  const lineId = str(data.jobEquipmentId);
  const buildComplete = data.buildComplete !== false;
  if (!jobId || !lineId) throw new HttpsError("invalid-argument", "jobId and jobEquipmentId are required.");

  const actor = await resolveActor(request, { pinToken: data.pinToken });
  requirePermission(actor, "canCreateQuote", "You do not have permission to update build status.");

  const lineRef = d.doc(`gpJobs/${jobId}/equipment/${lineId}`);
  const lineSnap = await lineRef.get();
  if (!lineSnap.exists) throw new HttpsError("not-found", "Equipment item not found for this job.");
  if (!lineSnap.data().buildRequired) throw new HttpsError("failed-precondition", "This item does not require a build.");

  await lineRef.update({
    buildComplete,
    buildCompletedBy: buildComplete ? actorLabel(actor) : "",
    buildCompletedAt: buildComplete ? now : null,
    updatedBy: actorLabel(actor), updatedAt: now,
  });

  const all = await d.collection(`gpJobs/${jobId}/equipment`).where("active", "==", true).get();
  const buildRows = all.docs.filter((x) => x.data().buildRequired);
  const allItemsBuilt = buildRows.length === 0 || buildRows.every((x) =>
    x.id === lineId ? buildComplete : x.data().buildComplete === true);

  await d.doc(`gpJobs/${jobId}`).update({
    hasBuildItems: buildRows.length > 0, allItemsBuilt,
    updatedBy: actorLabel(actor), updatedAt: now,
  });

  await d.doc(`gpJobs/${jobId}/history/${newId("HIS")}`).set({
    eventType: "Build Status Changed",
    description: buildComplete ? "Equipment build marked complete" : "Equipment build reopened",
    previousValue: lineSnap.data().buildComplete ? "Complete" : "Incomplete",
    newValue: buildComplete ? "Complete" : "Incomplete",
    performedBy: actorLabel(actor), performedAt: now, source: "GamePlan App",
  });

  return { jobId, jobEquipmentId: lineId, buildComplete, allItemsBuilt };
});

// ------------------------------------------------------------ updateJobDetails
export const updateJobDetails = onCall(async (request) => {
  const d = db();
  const data = request.data || {};
  const now = Timestamp.now();
  const jobId = str(data.jobId);
  const items = Array.isArray(data.equipment) ? data.equipment : [];
  if (!jobId) throw new HttpsError("invalid-argument", "jobId is required.");
  if (!items.length) throw new HttpsError("invalid-argument", "Equipment details are required.");

  const actor = await resolveActor(request, { pinToken: data.pinToken });
  requirePermission(actor, "canCreateQuote", "You do not have permission to update job details.");

  const jobRef = d.doc(`gpJobs/${jobId}`);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError("not-found", "Job not found.");

  const [brandsSnap, productsSnap] = await Promise.all([
    d.collection("gpBrands").get(),
    d.collection("gpProducts").get(),
  ]);
  const brandName = Object.fromEntries(brandsSnap.docs.map((x) => [x.id, x.data().name]));
  const products = Object.fromEntries(productsSnap.docs.map((x) => [x.id, x.data()]));

  for (const item of items) {
    const lineId = str(item.jobEquipmentId);
    const lineRef = d.doc(`gpJobs/${jobId}/equipment/${lineId}`);
    const lineSnap = await lineRef.get();
    if (!lineSnap.exists) throw new HttpsError("not-found", "An equipment item could not be found.");
    const line = lineSnap.data();

    const pickupOnly = line.pickupRequired === true && line.deliveryRequired === false;
    const hasCatalog = Object.values(products).some((p) => p.equipmentTypeId === line.equipmentTypeId);
    const description = str(item.description).slice(0, 120);

    if (pickupOnly) {
      // Free-text description for items with no catalog models (e.g. Other).
      if (!hasCatalog) {
        if (line.equipmentTypeId === "EQP-OTHER" && !description && !str(line.description)) {
          throw new HttpsError("invalid-argument", "Describe every Other item being picked up.");
        }
        if (description) {
          await lineRef.update({ description, updatedBy: actorLabel(actor), updatedAt: now });
        }
      }
      continue;
    }

    const isNew = String(line.condition || "").toLowerCase() === "new";
    let brand, model, productId = str(item.productId), imageUrl = str(line.imageUrl);

    if (isNew && !hasCatalog) {
      if (!description) throw new HttpsError("invalid-argument", "Enter a short description for every new item without catalog models.");
      await lineRef.update({
        description, itemDescription: description, productId: null,
        updatedBy: actorLabel(actor), updatedAt: now,
      });
      continue;
    }

    if (isNew) {
      const p = products[productId];
      if (!p) throw new HttpsError("invalid-argument", "Choose a valid model for every new item.");
      brand = brandName[p.brandId] || p.brandId;
      model = p.model;
      imageUrl = str(p.imageUrl) || imageUrl;
    } else {
      brand = str(item.manufacturer);
      model = str(item.model);
      if (!brand) throw new HttpsError("invalid-argument", "Enter the manufacturer for every used delivery item.");
      if (!model) throw new HttpsError("invalid-argument", "Enter the model for every used delivery item.");
      if (str(item.photoDataUrl)) {
        imageUrl = await uploadDataUrl(item.photoDataUrl, `gameplan/jobs/${jobId}/${lineId}-${Date.now()}.jpg`);
      }
      if (!imageUrl) throw new HttpsError("invalid-argument", "Add a photo for every used delivery item.");
    }

    await lineRef.update({
      brand, model, productId: productId || null, imageUrl,
      itemDescription: isNew ? model : (str(item.notes) || line.itemDescription || ""),
      updatedBy: actorLabel(actor), updatedAt: now,
    });
  }

  const job = jobSnap.data();
  const jobHasPickup = job.jobType !== "delivery";
  let pickupType = str(data.pickupType).toLowerCase().replace(/\s+/g, "-") || job.pickupType || null;
  if (pickupType === "sale") pickupType = "trade-in";
  if (jobHasPickup && !["trade-in", "disposal"].includes(pickupType)) {
    throw new HttpsError("invalid-argument", "Choose Trade-In or Disposal for the pickup.");
  }

  await jobRef.update({
    detailsStatus: "complete",
    detailsCompletedAt: now, detailsCompletedBy: actorLabel(actor),
    pickupType, pickupNotes: str(data.pickupNotes) || job.pickupNotes || "",
    updatedBy: actorLabel(actor), updatedAt: now,
  });

  await d.doc(`gpJobs/${jobId}/history/${newId("HIS")}`).set({
    eventType: "Details Completed", description: "Equipment and pickup details completed",
    previousValue: "", newValue: "complete",
    performedBy: actorLabel(actor), performedAt: now, source: "GamePlan App",
  });

  return { jobId, detailsStatus: "complete" };
});

// ----------------------------------------------- finalizePickupInspection
const CONDITIONS = ["Excellent", "Good", "Fair", "Poor"];
const RESULTS = ["Pass", "Issue", "N/A"];

export const finalizePickupInspection = onCall(async (request) => {
  const d = db();
  const data = request.data || {};
  const now = Timestamp.now();
  const jobId = str(data.jobId);
  const insp = data.inspection || {};
  if (!jobId) throw new HttpsError("invalid-argument", "jobId is required.");

  const pickupType = str(insp.pickupType).toLowerCase().replace(/\s+/g, "-");
  if (!["trade-in", "disposal"].includes(pickupType)) {
    throw new HttpsError("invalid-argument", "Choose Trade-In or Disposal.");
  }
  if (!CONDITIONS.includes(str(insp.overallCondition))) {
    throw new HttpsError("invalid-argument", "Choose an overall condition.");
  }
  if (!str(insp.signatureName)) throw new HttpsError("invalid-argument", "Customer name is required.");
  if (!str(insp.signatureDataUrl)) throw new HttpsError("invalid-argument", "Customer signature is required.");
  const itemsIn = Array.isArray(insp.items) ? insp.items : [];
  if (!itemsIn.length) throw new HttpsError("invalid-argument", "At least one pickup item is required.");

  const actor = await resolveActor(request, { pinToken: data.pinToken });
  requirePermission(actor, "canCreateQuote", "You do not have permission to finalize pickups.");

  const jobRef = d.doc(`gpJobs/${jobId}`);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError("not-found", "Job not found.");

  const existing = await d.collection(`gpJobs/${jobId}/pickupInspection`).limit(1).get();
  if (!existing.empty) throw new HttpsError("failed-precondition", "This pickup inspection is already finalized.");

  const inspectionId = newId("PINSP");
  let issueCount = 0;
  let photoCount = 0;
  const items = [];

  for (const item of itemsIn) {
    const lineId = str(item.jobEquipmentId);
    const lineSnap = await d.doc(`gpJobs/${jobId}/equipment/${lineId}`).get();
    if (!lineSnap.exists) throw new HttpsError("not-found", "A pickup equipment item could not be found.");
    if (!lineSnap.data().pickupRequired) throw new HttpsError("failed-precondition", "That item is not marked for pickup.");

    const responses = item.responses && typeof item.responses === "object" ? item.responses : {};
    const keys = Object.keys(responses);
    if (!keys.length) throw new HttpsError("invalid-argument", "Inspection responses are required for every item.");
    const issues = [];
    for (const k of keys) {
      const r = responses[k] || {};
      if (!RESULTS.includes(str(r.result))) throw new HttpsError("invalid-argument", "Every question needs Pass, Issue, or N/A.");
      if (str(r.result) === "Issue") {
        if (!str(r.note)) throw new HttpsError("invalid-argument", "Every reported issue needs a note.");
        issues.push(str(r.note));
        issueCount++;
      }
    }
    if (!str(item.photoDataUrl)) throw new HttpsError("invalid-argument", "A current photo is required for every pickup item.");
    if (item.disassembled && !str(item.disassemblyNotes)) {
      throw new HttpsError("invalid-argument", "Describe the disassembly for every disassembled item.");
    }
    const photoUrl = await uploadDataUrl(item.photoDataUrl, `gameplan/jobs/${jobId}/pickup-${lineId}-${Date.now()}.jpg`);
    photoCount++;

    items.push({
      jobEquipmentId: lineId, responses,
      issueSummary: issues.join(" | "), photoUrl,
      disassembled: !!item.disassembled, disassemblyNotes: str(item.disassemblyNotes),
      notes: str(item.notes),
    });
  }

  const signatureUrl = await uploadDataUrl(insp.signatureDataUrl, `gameplan/jobs/${jobId}/signature-${Date.now()}.png`);

  const batch = d.batch();
  batch.set(d.doc(`gpJobs/${jobId}/pickupInspection/${inspectionId}`), {
    pickupType, overallCondition: str(insp.overallCondition),
    additionalNotes: str(insp.notes),
    customerName: str(insp.signatureName), signatureUrl,
    completedBy: actorLabel(actor), completedAt: now,
    issueCount, photoCount, status: "Complete", items,
    createdAt: now, updatedAt: now,
  });
  batch.update(jobRef, {
    pickupType, pickupInspectionStatus: "complete", pickupInspectionId: inspectionId,
    updatedBy: actorLabel(actor), updatedAt: now,
  });
  batch.set(d.doc(`gpJobs/${jobId}/history/${newId("HIS")}`), {
    eventType: "Pickup Inspection Finalized",
    description: `${pickupType} pickup finalized · ${str(insp.overallCondition)} condition · ${issueCount} issue${issueCount === 1 ? "" : "s"} noted`,
    previousValue: "", newValue: inspectionId,
    performedBy: actorLabel(actor), performedAt: now, source: "GamePlan App",
  });
  await batch.commit();

  return { jobId, pickupInspectionId: inspectionId, pickupInspectionStatus: "complete", issueCount, photoCount };
});

// -------------------------------------------------------------- updateJobSchedule
const PIGGYBACK_RE = /^\[PIGGYBACK/i;

export const updateJobSchedule = onCall(async (request) => {
  const d = db();
  const data = request.data || {};
  const now = Timestamp.now();
  const jobId = str(data.jobId);
  if (!jobId) throw new HttpsError("invalid-argument", "jobId is required.");
  if (!str(data.scheduledDate) || !str(data.scheduledTime)) {
    throw new HttpsError("invalid-argument", "Choose a date and a start time.");
  }
  const piggyback = Boolean(data.piggyback);
  const when = combineLocalDateTime(data.scheduledDate, data.scheduledTime);

  const actor = await resolveActor(request, { pinToken: data.pinToken });
  requirePermission(actor, "canCreateQuote", "You do not have permission to reschedule jobs.");

  const jobRef = d.doc(`gpJobs/${jobId}`);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new HttpsError("not-found", "Job not found.");
  const job = jobSnap.data();

  const { soft: policySoft, hard: policyHard } = await schedulabilityReasons(when);
  if (policyHard.length) {
    throw new HttpsError("failed-precondition", `Closed to deliveries: ${policyHard.join("; ")}. Choose another date.`);
  }
  const overlapDocs = await overlappingScheduledJobs(when, job.durationMinutes, jobId);
  if (overlapDocs.length && !piggyback) {
    throw new HttpsError("failed-precondition",
      `This time overlaps an approved job (${overlapDocs.map((x) => x.data().jobNumber || x.id).join(", ")}). A manager must select the Piggyback option.`);
  }
  if (piggyback && !overlapDocs.length) {
    throw new HttpsError("failed-precondition", "The selected Piggyback overlap no longer exists. Reload the schedule and choose again.");
  }

  // Manager approval when moving a confirmed appointment or approving a piggyback.
  let approver = null;
  if (job.status === "scheduled" || piggyback) {
    approver = actor.permissions?.canApproveSchedule
      ? actor
      : await resolveActor(request, { pinToken: data.approvalToken });
    requirePermission(approver, "canApproveSchedule", "Manager approval is required to move this appointment.");
    if (piggyback) {
      requirePermission(approver, "canOverrideConflict", "This manager cannot approve Piggyback overlaps.");
    }
  }

  // Off-days / outside hours / soft blackouts need someone allowed to override.
  if (policySoft.length) {
    const overrider = actor.permissions?.canOverrideConflict
      ? actor
      : await resolveActor(request, { pinToken: data.approvalToken });
    requirePermission(overrider, "canOverrideConflict",
      `Manager override required: ${policySoft.join("; ")}.`);
    if (!approver) approver = overrider;
  }

  const partnerNumbers = overlapDocs.map((x) => x.data().jobNumber || x.id);
  const batch = d.batch();
  const jobUpdates = {
    scheduledAt: Timestamp.fromDate(when),
    scheduledDate: laDateString(when),
    updatedBy: actorLabel(actor), updatedAt: now,
  };
  if (approver && approver !== actor) { jobUpdates.approvedBy = actorLabel(approver); jobUpdates.approvedAt = now; }
  if (piggyback) {
    const marker = `[PIGGYBACK — MANAGER APPROVED WITH ${partnerNumbers.join(", ")}]`;
    jobUpdates.isPiggyback = true;
    jobUpdates.internalNotes = PIGGYBACK_RE.test(str(job.internalNotes))
      ? job.internalNotes
      : `${marker}${job.internalNotes ? `\n${job.internalNotes}` : ""}`;
  }
  batch.update(jobRef, jobUpdates);

  if (piggyback) {
    for (const partner of overlapDocs) {
      const pd = partner.data();
      const marker = `[PIGGYBACK — MANAGER APPROVED WITH ${job.jobNumber || jobId}]`;
      batch.update(partner.ref, {
        isPiggyback: true,
        internalNotes: str(pd.internalNotes).includes(marker)
          ? pd.internalNotes
          : `${marker}${pd.internalNotes ? `\n${pd.internalNotes}` : ""}`,
        updatedBy: actorLabel(actor), updatedAt: now,
      });
      batch.set(d.doc(`gpJobs/${partner.id}/history/${newId("HIS")}`), {
        eventType: "Piggyback Linked",
        description: `Manager-approved Piggyback with ${job.jobNumber || jobId} · Approved by ${actorLabel(approver)}`,
        previousValue: "", newValue: job.jobNumber || jobId,
        performedBy: actorLabel(actor), performedAt: now, source: "GamePlan App",
      });
    }
  }

  batch.set(d.doc(`gpJobs/${jobId}/history/${newId("HIS")}`), {
    eventType: piggyback ? "Piggyback Rescheduled" : "Appointment Rescheduled",
    description: (piggyback
      ? `Appointment moved into a manager-approved Piggyback overlap with ${partnerNumbers.join(", ")}`
      : "Appointment date and time updated") + (approver && approver !== actor ? ` · Approved by ${actorLabel(approver)}` : ""),
    previousValue: job.scheduledAt ? job.scheduledAt.toDate().toISOString() : "",
    newValue: when.toISOString(),
    performedBy: actorLabel(actor), performedAt: now, source: "GamePlan App",
  });

  await batch.commit();
  return {
    jobId, scheduledAt: when.toISOString(), piggyback,
    partnerJobIds: overlapDocs.map((x) => x.id),
    approvedBy: approver && approver !== actor ? actorLabel(approver) : "",
  };
});

// ============================================================ Daily Dashboard feed
// Real-time: any job change re-syncs its stores/soquel/deliveries docs.
export const onJobWriteSyncFeed = onDocumentWritten("gpJobs/{jobId}", async (event) => {
  const jobId = event.params.jobId;
  const after = event.data?.after;
  const job = after && after.exists ? after.data() : null;
  try {
    await syncJobFeed(jobId, job);
  } catch (err) {
    console.error(`feed sync failed for ${jobId}`, err);
  }
});

// Daily (05:00 America/Los_Angeles): roll pending builds / past-due jobs onto
// today, surface builds entering the 48h window, and prune old feed docs.
export const rollDailyFeed = onSchedule(
  { schedule: "every day 05:00", timeZone: "America/Los_Angeles" },
  async () => {
    const todayKey = laDateString(new Date());
    const jobs = await db().collection("gpJobs").where("archived", "==", false).get();
    let synced = 0;
    for (const doc of jobs.docs) {
      try {
        await syncJobFeed(doc.id, doc.data(), todayKey);
        synced++;
      } catch (err) {
        console.error(`daily feed sync failed for ${doc.id}`, err);
      }
    }
    const pruned = await pruneFeed(14);
    console.log(`rollDailyFeed: synced ${synced} jobs, pruned ${pruned} stale feed docs`);
  },
);

// Manager-triggered: re-sync every non-archived job's feed docs + prune.
// Handy for the initial backfill and if the feed ever drifts.
export const backfillFeed = onCall(async (request) => {
  const actor = await resolveActor(request, { pinToken: request.data?.pinToken });
  requirePermission(actor, "canApproveSchedule", "Manager access is required.");
  const todayKey = laDateString(new Date());
  const jobs = await db().collection("gpJobs").where("archived", "==", false).get();
  let synced = 0;
  for (const doc of jobs.docs) {
    try { await syncJobFeed(doc.id, doc.data(), todayKey); synced++; } catch (e) { /* logged in trigger */ }
  }
  const pruned = await pruneFeed(14);
  return { synced, pruned };
});

// ======================================================= availability admin
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_IDS = {
  Monday: "AVL-MON", Tuesday: "AVL-TUE", Wednesday: "AVL-WED", Thursday: "AVL-THU",
  Friday: "AVL-FRI", Saturday: "AVL-SAT", Sunday: "AVL-SUN",
};

async function auditAdmin(entity, entityId, action, oldValue, newValue, actor) {
  await db().doc(`gpAudit/${newId("AUD")}`).set({
    entity, entityId, action,
    oldValue: JSON.stringify(oldValue || {}), newValue: JSON.stringify(newValue || {}),
    performedBy: actorLabel(actor), performedAt: Timestamp.now(), source: "GamePlan App",
  });
}

async function requireScheduleAdmin(request, pinToken) {
  const actor = await resolveActor(request, { pinToken });
  requirePermission(actor, "canApproveSchedule", "Manager access is required to change availability.");
  return actor;
}

export const saveBlackoutDate = onCall(async (request) => {
  const data = request.data || {};
  const actor = await requireScheduleAdmin(request, data.pinToken);

  const startDate = str(data.startDate);
  const endDate = str(data.endDate) || startDate;
  const reason = str(data.reason).slice(0, 80);
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new HttpsError("invalid-argument", "Choose a valid date.");
  }
  if (endDate < startDate) throw new HttpsError("invalid-argument", "The end date can't be before the start date.");
  if (!reason) throw new HttpsError("invalid-argument", "Enter a reason (e.g. Christmas).");

  const id = str(data.id) || newId("BLK");
  const ref = db().doc(`gpBlackoutDates/${id}`);
  const before = await ref.get();
  const doc = {
    startDate, endDate, reason,
    overrideAllowed: data.overrideAllowed !== false,
    active: true,
    updatedBy: actorLabel(actor), updatedAt: Timestamp.now(),
  };
  if (!before.exists) { doc.createdBy = actorLabel(actor); doc.createdAt = Timestamp.now(); }
  await ref.set(doc, { merge: true });
  await auditAdmin("blackout", id, before.exists ? "Blackout Updated" : "Blackout Added",
    before.exists ? before.data() : {}, doc, actor);
  return { id };
});

export const deleteBlackoutDate = onCall(async (request) => {
  const data = request.data || {};
  const actor = await requireScheduleAdmin(request, data.pinToken);
  const id = str(data.id);
  if (!id) throw new HttpsError("invalid-argument", "id is required.");
  const ref = db().doc(`gpBlackoutDates/${id}`);
  const before = await ref.get();
  if (!before.exists) return { id, deleted: false };
  await ref.delete();
  await auditAdmin("blackout", id, "Blackout Removed", before.data(), {}, actor);
  return { id, deleted: true };
});

export const saveAvailability = onCall(async (request) => {
  const data = request.data || {};
  const actor = await requireScheduleAdmin(request, data.pinToken);
  const rules = Array.isArray(data.rules) ? data.rules : [];
  if (!rules.length) throw new HttpsError("invalid-argument", "No changes to save.");

  const batch = db().batch();
  const changes = [];
  for (const r of rules) {
    const day = str(r.day);
    const id = DAY_IDS[day];
    if (!id) throw new HttpsError("invalid-argument", `Unknown day: ${day}`);
    const startTime = str(r.startTime) || null;
    const endTime = str(r.endTime) || null;
    if ((startTime && !HHMM_RE.test(startTime)) || (endTime && !HHMM_RE.test(endTime))) {
      throw new HttpsError("invalid-argument", `${day}: enter times like 09:00.`);
    }
    if (Boolean(startTime) !== Boolean(endTime)) {
      throw new HttpsError("invalid-argument", `${day}: set both an opening and a closing time, or leave both blank.`);
    }
    if (startTime && endTime && startTime >= endTime) {
      throw new HttpsError("invalid-argument", `${day}: the closing time must be after the opening time.`);
    }
    const next = {
      day, available: r.available !== false, startTime, endTime,
      overrideAllowed: r.overrideAllowed !== false, active: true,
      updatedBy: actorLabel(actor), updatedAt: Timestamp.now(),
    };
    const ref = db().doc(`gpAvailabilityRules/${id}`);
    const before = await ref.get();
    batch.set(ref, next, { merge: true });
    changes.push({ id, before: before.exists ? before.data() : {}, next });
  }
  await batch.commit();
  for (const c of changes) await auditAdmin("availability", c.id, "Weekly Availability Updated", c.before, c.next, actor);
  return { saved: changes.length };
});

// ============================================================ pricing admin
const PRICING_LIMITS = {
  baseTripCharge: [0, 2000], vehicleRatePerMile: [0, 50], laborRatePerEmployeeHour: [0, 500],
  minimumServiceCharge: [0, 2000], priceRoundingIncrement: [1, 100],
  usedItemDeliveryCharge: [0, 1000], tradeInPickupDiscount: [0, 1000],
};
const TYPE_LIMITS = {
  deliveryMinutes: [0, 1440], pickupMinutes: [0, 1440], defaultCrewSize: [1, 10],
  defaultAssemblyCharge: [0, 2000], defaultDisposalCharge: [0, 2000],
};
const ACCESS_LIMITS = { defaultMinutes: [0, 600], flatCharge: [0, 2000] };

function cleanNumbers(input, limits, label) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    const range = limits[key];
    if (!range) throw new HttpsError("invalid-argument", `${label}: "${key}" can't be changed here.`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < range[0] || n > range[1]) {
      throw new HttpsError("invalid-argument", `${label}: ${key} must be between ${range[0]} and ${range[1]}.`);
    }
    out[key] = key === "defaultCrewSize" ? Math.round(n) : Math.round(n * 100) / 100;
  }
  return out;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}

function cleanScenarios(list, typeIds, accessIds) {
  if (!Array.isArray(list) || list.length > 12) throw new HttpsError("invalid-argument", "Keep sample jobs to 12 or fewer.");
  return list.map((s, i) => {
    const name = str(s.name).slice(0, 60);
    if (!name) throw new HttpsError("invalid-argument", `Sample job ${i + 1} needs a name.`);
    const miles = Number(s.roundTripMiles), minutes = Number(s.driveMinutes);
    if (!(miles >= 0 && miles <= 500) || !(minutes >= 0 && minutes <= 600)) {
      throw new HttpsError("invalid-argument", `${name}: check the miles and drive minutes.`);
    }
    const pickupType = ["trade-in", "disposal"].includes(s.pickupType) ? s.pickupType : null;
    const items = (Array.isArray(s.items) ? s.items : []).slice(0, 6).map((it) => {
      if (!typeIds.has(str(it.equipmentTypeId))) throw new HttpsError("invalid-argument", `${name}: unknown equipment type.`);
      const qty = Math.round(Number(it.quantity));
      if (!(qty >= 1 && qty <= 20)) throw new HttpsError("invalid-argument", `${name}: quantity must be 1–20.`);
      return {
        equipmentTypeId: str(it.equipmentTypeId),
        condition: it.condition === "new" ? "new" : "used",
        quantity: qty,
        movement: it.movement === "pickup" ? "pickup" : "delivery",
      };
    });
    if (!items.length) throw new HttpsError("invalid-argument", `${name}: add at least one item.`);
    const access = (Array.isArray(s.access) ? s.access : []).map(str).filter((id) => accessIds.has(id));
    return { id: str(s.id) || newId("SCN"), name, roundTripMiles: miles, driveMinutes: minutes, pickupType, items, access };
  });
}

export const savePricing = onCall(async (request) => {
  const data = request.data || {};
  const actor = await resolveActor(request, { pinToken: data.pinToken });
  requirePermission(actor, "canEditCMS", "Administrator access is required to change pricing.");

  const d = db();
  const now = Timestamp.now();
  const batch = d.batch();
  const audits = [];
  const who = { updatedBy: actorLabel(actor), updatedAt: now };

  if (data.settings && Object.keys(data.settings).length) {
    const clean = cleanNumbers(data.settings, PRICING_LIMITS, "Rates");
    const ref = d.doc("gpConfig/pricing");
    const before = await ref.get();
    batch.set(ref, { ...clean, ...who }, { merge: true });
    audits.push({ id: "pricing", before: pick(before.data(), Object.keys(clean)), after: clean });
  }

  for (const t of Array.isArray(data.equipmentTypes) ? data.equipmentTypes : []) {
    const id = str(t.id);
    const ref = d.doc(`gpEquipmentTypes/${id}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", `Equipment type ${id} no longer exists.`);
    const clean = cleanNumbers(t.values, TYPE_LIMITS, snap.data().name || id);
    if (!Object.keys(clean).length) continue;
    batch.set(ref, { ...clean, ...who }, { merge: true });
    audits.push({ id, before: pick(snap.data(), Object.keys(clean)), after: clean });
  }

  for (const a of Array.isArray(data.accessConditions) ? data.accessConditions : []) {
    const id = str(a.id);
    const ref = d.doc(`gpAccessConditions/${id}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", `Access condition ${id} no longer exists.`);
    const clean = cleanNumbers(a.values, ACCESS_LIMITS, snap.data().name || id);
    if (!Object.keys(clean).length) continue;
    batch.set(ref, { ...clean, ...who }, { merge: true });
    audits.push({ id, before: pick(snap.data(), Object.keys(clean)), after: clean });
  }

  if (Array.isArray(data.scenarios)) {
    const [ts, as] = await Promise.all([d.collection("gpEquipmentTypes").get(), d.collection("gpAccessConditions").get()]);
    const items = cleanScenarios(data.scenarios, new Set(ts.docs.map((x) => x.id)), new Set(as.docs.map((x) => x.id)));
    batch.set(d.doc("gpConfig/pricingScenarios"), { items, ...who });
  }

  await batch.commit();
  for (const a of audits) await auditAdmin("pricing", a.id, "Pricing Updated", a.before, a.after, actor);
  return { saved: true, changed: audits.length };
});
