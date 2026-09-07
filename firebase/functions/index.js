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
    clashes = await assertNoConflict(job.scheduledAt.toDate(), job.durationMinutes, jobId, Boolean(data.overrideSchedule));
    if (clashes.length) requirePermission(approver, "canOverrideConflict", "This manager cannot override schedule conflicts.");
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
    if (pickupOnly) continue;

    const isNew = String(line.condition || "").toLowerCase() === "new";
    let brand, model, productId = str(item.productId), imageUrl = str(line.imageUrl);

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
