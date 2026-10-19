// Publishes GamePlan's "today feed" into stores/soquel/deliveries/{id} for the
// Daily Inventory Operations dashboard. Same project, so plain Admin SDK writes.
//
// Doc ids are deterministic: gp_<jobId>_delivery | _pickup | _build
// Contract: see firebase/docs/dashboard-handoff.md
//
// Also publishes a MANAGER-ONLY "awaiting approval" doc per Tentative job that
// has a requested appointment: stores/soquel/gpPending/gp_<jobId>_pending.
// It is a separate collection on purpose — the dashboard shows every doc in
// `deliveries` to all users (employees included), so pending approvals must not
// live there.

import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { db, num, str } from "./common.mjs";
import { laDateString } from "./schedule.mjs";

const FEED = "stores/soquel/deliveries";
const PENDING = "stores/soquel/gpPending";
const KINDS = ["delivery", "pickup", "build"];
const BUILD_LEAD_MS = 48 * 60 * 60 * 1000;

let equipmentNameCache = null;
async function equipmentName(id) {
  if (!equipmentNameCache) {
    const snap = await db().collection("gpEquipmentTypes").get();
    equipmentNameCache = Object.fromEntries(snap.docs.map((d) => [d.id, d.data().name || d.id]));
  }
  return equipmentNameCache[id] || id;
}

async function jobSummary(jobId) {
  const snap = await db().collection(`gpJobs/${jobId}/equipment`).get();
  const rows = snap.docs.map((d) => d.data()).filter((r) => r.active !== false);
  let itemCount = 0;
  const parts = [];
  for (const r of rows) {
    const qty = Math.max(1, num(r.quantity) || 1);
    itemCount += qty;
    const typeName = await equipmentName(r.equipmentTypeId);
    const name = r.description ? `${typeName} (${str(r.description)})` : typeName;
    parts.push(qty > 1 ? `${qty}× ${name}` : name);
  }
  return { summary: parts.slice(0, 4).join(" + ") + (parts.length > 4 ? " + …" : ""), itemCount };
}

/**
 * Desired feed docs for a job right now. `todayKey` lets the daily job pin
 * rolled-forward items to the current date.
 */
export async function feedDocsForJob(jobId, job, todayKey = laDateString(new Date())) {
  if (!job || job.archived === true) return [];
  const status = str(job.status);
  if (!["scheduled", "completed", "cancelled"].includes(status)) return [];

  const scheduledAt = job.scheduledAt || null;
  if (!scheduledAt) return [];
  const startMs = scheduledAt.toMillis();
  const apptKey = laDateString(scheduledAt.toDate());
  const kind = str(job.jobType); // delivery | pickup | delivery+pickup
  const feedStatus = status === "completed" ? "done" : status === "cancelled" ? "cancelled" : "scheduled";
  const { summary, itemCount } = await jobSummary(jobId);

  const base = {
    customerName: str(job.customerName),
    summary, itemCount,
    assignedToName: null, window: null, notes: null,
    sourceJobId: jobId,
    updatedAt: FieldValue.serverTimestamp(),
  };
  const docs = [];

  const wantsDelivery = kind === "delivery" || kind === "delivery+pickup";
  const wantsPickup = kind === "pickup" || kind === "delivery+pickup";
  // Open jobs past their date roll forward onto "today" until closed.
  const rolledDate = status === "scheduled" && apptKey < todayKey ? todayKey : apptKey;

  if (wantsDelivery) {
    docs.push({
      id: `gp_${jobId}_delivery`,
      data: { ...base, kind: "delivery", date: rolledDate, scheduledAt, status: feedStatus, address: str(job.serviceAddress) || null },
    });
  }
  if (wantsPickup) {
    docs.push({
      id: `gp_${jobId}_pickup`,
      data: { ...base, kind: "pickup", date: rolledDate, scheduledAt, status: feedStatus, address: str(job.serviceAddress) || null },
    });
  }

  // Build: appears 48h before the appointment, rolls forward until built/passed.
  const needsBuild = status === "scheduled" && job.hasBuildItems === true && job.allItemsBuilt !== true;
  const within48h = Date.now() >= startMs - BUILD_LEAD_MS;
  const notPast = Date.now() < startMs;
  if (needsBuild && within48h && notPast) {
    docs.push({
      id: `gp_${jobId}_build`,
      data: {
        ...base, kind: "build", date: todayKey, scheduledAt,
        buildDueBy: Timestamp.fromMillis(startMs - BUILD_LEAD_MS),
        status: "scheduled", address: "In store",
      },
    });
  }
  return docs;
}

/**
 * The "awaiting manager approval" doc for a job, or null. Only Tentative jobs
 * that carry a requested appointment still in the future qualify (same test the
 * app's Needs Attention list uses).
 */
export async function pendingDocForJob(jobId, job) {
  if (!job || job.archived === true) return null;
  if (str(job.status) !== "unscheduled" || !job.scheduledAt) return null;
  if (job.scheduledAt.toMillis() < Date.now()) return null;
  const { summary, itemCount } = await jobSummary(jobId);
  return {
    id: `gp_${jobId}_pending`,
    data: {
      status: "pending",
      jobType: str(job.jobType), // delivery | pickup | delivery+pickup
      date: laDateString(job.scheduledAt.toDate()),
      requestedAt: job.scheduledAt,
      customerName: str(job.customerName),
      summary, itemCount,
      address: str(job.serviceAddress) || null,
      needsDetails: job.detailsStatus !== "complete",
      createdByName: str(job.createdBy) || null,
      jobCreatedAt: job.createdAt || null,
      sourceJobId: jobId,
      updatedAt: FieldValue.serverTimestamp(),
    },
  };
}

/** Upsert the job's desired feed docs and delete any of its stale ones. */
export async function syncJobFeed(jobId, job, todayKey) {
  const want = await feedDocsForJob(jobId, job, todayKey);
  const wantIds = new Set(want.map((w) => w.id));
  const pending = await pendingDocForJob(jobId, job);
  const batch = db().batch();

  if (pending) batch.set(db().doc(`${PENDING}/${pending.id}`), pending.data, { merge: true });
  else batch.delete(db().doc(`${PENDING}/gp_${jobId}_pending`));

  for (const w of want) {
    batch.set(db().doc(`${FEED}/${w.id}`), { ...w.data, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  for (const kind of KINDS) {
    const id = `gp_${jobId}_${kind}`;
    if (!wantIds.has(id)) batch.delete(db().doc(`${FEED}/${id}`));
  }
  await batch.commit();
}

/** Delete feed docs whose `date` is more than `days` before today. */
export async function pruneFeed(days = 14) {
  const cutoff = laDateString(new Date(Date.now() - days * 86400000));
  const stale = await db().collection(FEED).where("date", "<", cutoff).get();
  if (stale.empty) return 0;
  const batch = db().batch();
  stale.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return stale.size;
}
