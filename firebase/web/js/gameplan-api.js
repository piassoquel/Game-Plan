// Drop-in replacement for the old Apps Script `api.js`. Same class name, same
// method names and return shapes — but backed by Firestore. app.js does not
// need to know the backend changed.
//
// Phase 2 implements the read methods (authenticate / getBootstrap / getDirectory
// / getHistory / getJob). Write methods throw a friendly "not yet" until Phase 3.
import {
  collection, query, where, getDocs, doc, getDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db, auth, functions, httpsCallable } from "./firebase-app.js?v=fb25";
import { enqueue, flush, count, looksOffline } from "./offline-queue.js?v=fb25";

const call = (name) => httpsCallable(functions, name);

// Writes that are safe to defer when offline (post-appointment field work).
const OFFLINE_ELIGIBLE = new Set([
  "updateJobStatus", "updateJobDetails", "updateEquipmentBuildStatus", "finalizePickupInspection",
]);

async function offlineWrite(name, payload) {
  try {
    const res = await call(name)(payload);
    return res.data;
  } catch (error) {
    if (OFFLINE_ELIGIBLE.has(name) && looksOffline(error)) {
      const entry = await enqueue(name, payload);
      return { queued: true, offlineId: entry.id };
    }
    throw error;
  }
}

const LA = "America/Los_Angeles";
const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: LA, weekday: "short", month: "short", day: "numeric" });
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: LA, hour: "numeric", minute: "2-digit", hour12: true });

const STATUS_TO_UI = {
  unscheduled: "Tentative",
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
};

function notYet() {
  return new Error("That action isn't available in the preview yet — it arrives in the next update.");
}

const ts = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v ? new Date(v) : null);

function durationLabel(minutes) {
  if (!minutes) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m} min`;
  return `${h} hr${m ? ` ${m} min` : ""}`;
}

async function readCollection(name) {
  const snap = await getDocs(collection(db, name));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export class GamePlanApi {
  constructor() {}
  get isConfigured() { return true; }
  setGoogleIdToken() {}
  clearGoogleIdToken() {}

  // --- auth ---------------------------------------------------------
  async authenticate() {
    const fbUser = auth.currentUser;
    if (!fbUser) throw new Error("Google sign-in is required.");
    const email = String(fbUser.email || "").toLowerCase();

    const loginSnap = await getDoc(doc(db, "gpLoginAccounts", email));
    if (!loginSnap.exists() || loginSnap.data().active !== true) {
      throw new Error(`This Google account is not authorized for GamePlan: ${email}`);
    }
    const login = loginSnap.data();

    if (login.sharedAccount) {
      return {
        currentUser: {
          email,
          displayName: "Shared Employee Account",
          roleId: "",
          roleName: "Shared Account",
          permissions: {},
          sharedAccount: true,
          pinRequired: true,
        },
        staffChoices: [],
        pinMode: "pin-only",
      };
    }

    const staffSnap = await getDocs(query(
      collection(db, "gpStaff"),
      where("loginEmail", "==", email),
      where("active", "==", true),
    ));
    if (staffSnap.empty) throw new Error("No active staff profile is assigned to this Google account.");
    const staff = { id: staffSnap.docs[0].id, ...staffSnap.docs[0].data() };
    const roleSnap = await getDoc(doc(db, "gpRoles", staff.roleId));
    const role = roleSnap.exists() ? roleSnap.data() : { name: staff.roleId, permissions: {} };

    return {
      currentUser: {
        email,
        displayName: staff.displayName || fbUser.displayName || email,
        staffProfileId: staff.id,
        roleId: staff.roleId,
        roleName: role.name || staff.roleId,
        permissions: role.permissions || {},
        sharedAccount: false,
        pinRequired: false,
      },
      staffChoices: [],
      pinMode: "not-required",
    };
  }

  // --- bootstrap (working set + reference data) -------------------
  async getBootstrap() {
    const [
      auth0, jobDocs, customers, equipmentTypes, jobTypes, accessConditions,
      brands, products, availabilityRules, blackoutDates, pricingDoc, schedulingDoc,
    ] = await Promise.all([
      this.authenticate(),
      getDocs(query(collection(db, "gpJobs"), where("archived", "==", false))),
      this.#customersWithAddresses(),
      readCollection("gpEquipmentTypes"),
      readCollection("gpJobTypes"),
      readCollection("gpAccessConditions"),
      readCollection("gpBrands"),
      readCollection("gpProducts"),
      readCollection("gpAvailabilityRules"),
      readCollection("gpBlackoutDates"),
      getDoc(doc(db, "gpConfig", "pricing")),
      getDoc(doc(db, "gpConfig", "scheduling")),
    ]);

    const jobTypeById = Object.fromEntries(jobTypes.map((t) => [t.id, t]));
    const customerById = Object.fromEntries(customers.map((c) => [c.id, c]));
    const jobs = await Promise.all(
      jobDocs.docs.map((d) => this.#adaptJob(d, { jobTypeById, customerById })),
    );

    const pricing = pricingDoc.exists() ? pricingDoc.data() : {};
    const scheduling = schedulingDoc.exists() ? schedulingDoc.data() : {};

    return {
      jobs,
      customers,
      equipmentTypes: equipmentTypes.sort(byOrder),
      jobTypes: jobTypes.sort(byOrder),
      accessConditions: accessConditions.sort(byOrder),
      brands: brands.sort((a, b) => (a.name || "").localeCompare(b.name || "")),
      products,
      fulfillmentConditions: [],
      availabilityRules: availabilityRules.filter((r) => r.active !== false),
      blackoutDates: blackoutDates.filter((b) => b.active !== false),
      pricingSettings: {
        storeAddress: scheduling.storeAddress || "",
        confirmationBufferMinutes: scheduling.confirmationBufferMinutes || 10,
        laborRatePerEmployeeHour: pricing.laborRatePerEmployeeHour || 0,
        vehicleRatePerMile: pricing.vehicleRatePerMile || 0,
        minimumServiceCharge: pricing.minimumServiceCharge || 0,
        priceRoundingIncrement: pricing.priceRoundingIncrement || 5,
        baseTripCharge: pricing.baseTripCharge || 0,
        usedItemDeliveryCharge: pricing.usedItemDeliveryCharge || 0,
        tradeInPickupDiscount: Math.max(0, pricing.tradeInPickupDiscount || 0),
      },
      currentUser: auth0.currentUser,
      staffChoices: auth0.staffChoices || [],
    };
  }

  // Per-job activity log (gpJobs/<id>/history), oldest first.
  async getJobHistory(jobId) {
    const snap = await getDocs(collection(db, `gpJobs/${jobId}/history`));
    return snap.docs.map((d) => {
      const h = d.data();
      return {
        id: d.id,
        eventType: h.eventType || "",
        description: h.description || "",
        performedBy: h.performedBy || "",
        performedAt: h.performedAt ? ts(h.performedAt).toISOString() : "",
        source: h.source || "",
      };
    }).sort((a, b) => String(a.performedAt).localeCompare(String(b.performedAt)));
  }

  async getDirectory() {
    return { customers: await this.#customersWithAddresses() };
  }

  async getHistory() {
    const jobDocs = await getDocs(query(collection(db, "gpJobs"), where("archived", "==", true)));
    const [jobTypes, customers] = await Promise.all([
      readCollection("gpJobTypes"),
      this.#customersWithAddresses(),
    ]);
    const jobTypeById = Object.fromEntries(jobTypes.map((t) => [t.id, t]));
    const customerById = Object.fromEntries(customers.map((c) => [c.id, c]));
    const jobs = await Promise.all(
      jobDocs.docs.map((d) => this.#adaptJob(d, { jobTypeById, customerById })),
    );
    return { jobs };
  }

  async getJob(jobId) {
    const d = await getDoc(doc(db, "gpJobs", jobId));
    if (!d.exists()) throw new Error("Job not found");
    const [jobTypes, customers] = await Promise.all([
      readCollection("gpJobTypes"),
      this.#customersWithAddresses(),
    ]);
    const jobTypeById = Object.fromEntries(jobTypes.map((t) => [t.id, t]));
    const customerById = Object.fromEntries(customers.map((c) => [c.id, c]));
    const job = await this.#adaptJob(d, { jobTypeById, customerById, withPickup: true });
    return job;
  }

  // --- write methods -------------------------------------------
  async verifyPin(pin, requiredPermission = "") {
    const res = await call("verifyPin")({ pin, requiredPermission });
    return res.data;
  }

  async createJob(jobData, pinToken = "") {
    const res = await call("createJob")({ ...jobData, pinToken });
    return res.data;
  }

  async updateJobStatus(jobId, newStatus, statusNote = "", pinToken = "", approvalToken = "", overrideSchedule = false, scheduleOverrideType = "", overridePickupInspection = false) {
    return offlineWrite("updateJobStatus", { jobId, newStatus, statusNote, pinToken, approvalToken, overrideSchedule, scheduleOverrideType, overridePickupInspection });
  }

  async updateJobDetails(jobId, equipment, pickupType = "", pickupNotes = "", pinToken = "") {
    return offlineWrite("updateJobDetails", { jobId, equipment, pickupType, pickupNotes, pinToken });
  }

  // Add pickup item(s) to an open job and re-quote it. `preview` returns the new
  // quote without saving. Online only (it re-prices on the server).
  async addPickupToJob(jobId, items, pickupType = "", { preview = false, overrideSchedule = false } = {}, pinToken = "") {
    const res = await call("addPickupToJob")({ jobId, items, pickupType, preview, overrideSchedule, pinToken });
    return res.data;
  }

  async pendingWriteCount() { return count(); }

  async flushOfflineQueue({ onError } = {}) {
    return flush({
      updateJobStatus: (p) => call("updateJobStatus")(p),
      updateJobDetails: (p) => call("updateJobDetails")(p),
      updateEquipmentBuildStatus: (p) => call("updateEquipmentBuildStatus")(p),
      finalizePickupInspection: (p) => call("finalizePickupInspection")(p),
    }, { onError });
  }

  async updateJobSchedule(jobId, scheduledDate, scheduledTime, pinToken = "", approvalToken = "", piggyback = false) {
    const res = await call("updateJobSchedule")({ jobId, scheduledDate, scheduledTime, pinToken, approvalToken, piggyback });
    return res.data;
  }

  async updateEquipmentBuildStatus(jobId, jobEquipmentId, buildComplete = true, pinToken = "", approvalToken = "") {
    return offlineWrite("updateEquipmentBuildStatus", { jobId, jobEquipmentId, buildComplete, pinToken, approvalToken });
  }
  async finalizePickupInspection(jobId, inspection, pinToken = "") {
    return offlineWrite("finalizePickupInspection", { jobId, inspection, pinToken });
  }
  async saveBlackoutDate(payload, pinToken = "") {
    const res = await call("saveBlackoutDate")({ ...payload, pinToken });
    return res.data;
  }

  async deleteBlackoutDate(id, pinToken = "") {
    const res = await call("deleteBlackoutDate")({ id, pinToken });
    return res.data;
  }

  async savePricing(payload, pinToken = "") {
    const res = await call("savePricing")({ ...payload, pinToken });
    return res.data;
  }

  async getPricingScenarios() {
    const snap = await getDoc(doc(db, "gpConfig", "pricingScenarios"));
    return snap.exists() ? (snap.data().items || []) : [];
  }

  async saveAvailability(rules, pinToken = "") {
    const res = await call("saveAvailability")({ rules, pinToken });
    return res.data;
  }

  async backfillFeed(pinToken = "") {
    const res = await call("backfillFeed")({ pinToken });
    return res.data;
  }

  // Staff list for the Employee Management screen. PIN hashes are never
  // readable here (server-only); pinConfigured is just a flag on the record.
  async getStaffManagement() {
    const [staffSnap, loginSnap, roleSnap] = await Promise.all([
      getDocs(collection(db, "gpStaff")), getDocs(collection(db, "gpLoginAccounts")), getDocs(collection(db, "gpRoles")),
    ]);
    const loginAccounts = loginSnap.docs.map((d) => {
      const l = d.data();
      return { id: l.loginAccountId || d.id, email: d.id, sharedAccount: !!l.sharedAccount, active: l.active === true };
    });
    const byEmail = Object.fromEntries(loginAccounts.map((l) => [l.email, l]));
    const profiles = staffSnap.docs.map((d) => {
      const p = d.data();
      const acct = byEmail[String(p.loginEmail || "").toLowerCase()] || {};
      return {
        id: d.id,
        displayName: p.displayName || d.id,
        loginAccountId: acct.id || "",
        googleEmail: acct.sharedAccount ? "" : (p.loginEmail || ""),
        sharedAccount: !!acct.sharedAccount,
        roleId: p.roleId || "",
        pinEnabled: !!p.pinEnabled,
        pinConfigured: !!p.pinConfigured,
        active: p.active === true,
        updatedAt: p.updatedAt ? ts(p.updatedAt).toISOString() : "",
      };
    });
    const roles = roleSnap.docs.filter((d) => d.data().active !== false)
      .map((d) => ({ id: d.id, name: d.data().name || d.id, permissions: d.data().permissions || {} }));
    return { profiles, roles, loginAccounts };
  }

  async saveStaffProfile(staffData, pinToken = "") {
    const res = await call("saveStaffProfile")({ ...staffData, pinToken });
    return res.data;
  }
  async saveCustomer() { throw notYet(); }

  async calculateRoute(destinationAddress, destinationPlaceId = "") {
    const res = await call("calculateRoute")({ destinationAddress, destinationPlaceId });
    return res.data;
  }

  // --- internals ----------------------------------------------
  async #customersWithAddresses() {
    const custSnap = await getDocs(collection(db, "gpCustomers"));
    return Promise.all(custSnap.docs.map(async (c) => {
      const addrSnap = await getDocs(collection(db, `gpCustomers/${c.id}/addresses`));
      const data = c.data();
      return {
        id: c.id,
        firstName: data.firstName || "",
        lastName: data.lastName || "",
        name: data.name || c.id,
        phone: data.primaryPhoneDisplay || data.primaryPhone || "",
        email: data.email || "",
        companyName: data.companyName || "",
        addresses: addrSnap.docs.map((a) => {
          const ad = a.data();
          return {
            id: a.id,
            label: ad.label || "Service Address",
            address: ad.formattedAddress || "",
            placeId: ad.placeId || "",
            latitude: ad.latitude ?? null,
            longitude: ad.longitude ?? null,
            accessNotes: ad.accessNotes || "",
            default: !!ad.isDefault,
          };
        }),
      };
    }));
  }

  async #adaptJob(d, { jobTypeById, customerById, withPickup = false }) {
    const j = d.data();
    const [eqSnap, acSnap] = await Promise.all([
      getDocs(collection(db, `gpJobs/${d.id}/equipment`)),
      getDocs(collection(db, `gpJobs/${d.id}/access`)),
    ]);
    const start = ts(j.scheduledAt);
    const customer = customerById?.[j.customerId];
    const typeName = j.jobTypeName || jobTypeById?.[j.jobType]?.name || j.jobType || "Delivery";
    const hasPickup = /pick ?up/i.test(typeName) || j.jobType === "pickup" || j.jobType === "delivery+pickup";

    const equipment = eqSnap.docs.map((e) => {
      const ed = e.data();
      return {
        id: e.id,
        brand: ed.brand || "",
        model: ed.model || "",
        productId: ed.productId || "",
        equipmentTypeId: ed.equipmentTypeId || "",
        type: ed.equipmentTypeId || "",
        condition: ed.condition || "used",
        quantity: Math.max(1, Number(ed.quantity) || 1),
        imageUrl: ed.imageUrl || "",
        description: ed.description || "",
        deliveryRequired: !!ed.deliveryRequired,
        pickupRequired: !!ed.pickupRequired,
        buildRequired: !!ed.buildRequired,
        buildComplete: !!ed.buildComplete,
        buildCompletedBy: ed.buildCompletedBy || "",
        buildCompletedAt: ed.buildCompletedAt ? ts(ed.buildCompletedAt).toISOString() : "",
      };
    }).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    const access = acSnap.docs.map((a) => {
      const ad = a.data();
      return {
        id: a.id,
        accessConditionId: ad.accessConditionId || "",
        name: ad.name || ad.accessConditionId || "",
        iconName: ad.iconName || "",
        quantity: Math.max(1, Number(ad.quantity) || 1),
        addedMinutes: Number(ad.addedMinutes) || 0,
        addedLaborCharge: Number(ad.addedLaborCharge) || 0,
      };
    });

    const crewSize = equipment.reduce((m, e) => Math.max(m, e.minimumCrewSize || 0), 0) || 2;

    const job = {
      id: d.id,
      number: j.jobNumber || d.id,
      customerId: j.customerId || "",
      customer: j.customerName || customer?.name || j.customerId || "",
      phone: j.customerPhone || customer?.phone || "",
      date: start ? fmtDate.format(start) : "Unscheduled",
      time: start ? fmtTime.format(start) : "—",
      dateTime: start ? start.toISOString() : "",
      type: typeName,
      address: j.serviceAddress || "",
      status: STATUS_TO_UI[j.status] || "Scheduled",
      piggyback: !!j.isPiggyback,
      internalNotes: j.internalNotes || "",
      createdBy: j.createdBy || "",
      createdAt: j.createdAt ? ts(j.createdAt).toISOString() : "",
      updatedBy: j.updatedBy || "",
      updatedAt: j.updatedAt ? ts(j.updatedAt).toISOString() : "",
      total: Number(j.finalTotal) || 0,
      crewSize,
      duration: durationLabel(j.durationMinutes),
      durationMinutes: Math.max(30, Number(j.durationMinutes) || 0),
      buildRequired: !!j.hasBuildItems,
      buildComplete: !!j.allItemsBuilt,
      hasPickup,
      pickupType: j.pickupType || "",
      pickupNotes: j.pickupNotes || "",
      pickupInspectionStatus: j.pickupInspectionStatus || (hasPickup ? "needed" : "not-needed"),
      detailsStatus: j.detailsStatus || "needed",
      equipment,
      access,
      pickupSummary: null,
    };

    if (withPickup && hasPickup) {
      const piSnap = await getDocs(collection(db, `gpJobs/${d.id}/pickupInspection`));
      if (!piSnap.empty) {
        const pi = piSnap.docs[0].data();
        job.pickupSummary = {
          pickupType: pi.pickupType || "",
          overallCondition: pi.overallCondition || "",
          issueCount: Number(pi.issueCount) || 0,
          photoCount: Number(pi.photoCount) || 0,
          customerName: pi.customerName || "",
          signatureUrl: pi.signatureUrl || "",
          completedBy: pi.completedBy || "",
          completedAt: pi.completedAt ? ts(pi.completedAt).toISOString() : "",
          notes: pi.additionalNotes || "",
          items: pi.items || [],
        };
        job.pickupInspectionStatus = "complete";
      }
    }

    return job;
  }
}

function byOrder(a, b) {
  return (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || "").localeCompare(b.name || "");
}
