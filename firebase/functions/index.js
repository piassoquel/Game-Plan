// GamePlan Cloud Functions — codebase "gameplan" in daily-inventory-operations.
//
// Phase 3 will add here:
//   - createJob      (callable) — validates, prices via ./pricing.mjs, writes
//                     gpJobs + subcollections atomically, dedupes customer
//   - updateJobStatus / completeJob / cancelJob (callable)
//   - recomputeJob   (Firestore trigger) — re-price + re-duration on edit
//   - verifyPin      (callable) — shared-account PIN -> short-lived approval
// Phase 3 (dashboard):
//   - publishTodayFeed (trigger + daily schedule) -> stores/soquel/deliveries
//
// pricing.mjs is copied from web/js/pricing.mjs by the firebase.json predeploy
// hook so the wizard preview and server pricing stay identical.

import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// (functions exported in Phase 3)
