import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkbook } from "./lib/read-workbook.mjs";
import { transform } from "./transform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DEFAULT_FILE =
  "/Users/thegruntlaptop/Downloads/GamePlan CMS (current090726).xlsx";
const file = resolve(opt("--file", DEFAULT_FILE));
const outPath = resolve(HERE, opt("--out", "data/firestore.json"));
const PROD = has("--prod");
const PROJECT = "daily-inventory-operations";

function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      o[k] = prune(val);
    }
    return o;
  }
  return v;
}

console.log(`\nGamePlan import  ·  source: ${file}`);
const sheets = readWorkbook(file);
const writes = transform(sheets).map((w) => ({ ...w, data: prune(w.data) }));

// group + summarise
const byCollection = {};
for (const wr of writes) {
  const root = wr.path.split("/")[0];
  (byCollection[root] ||= []).push(wr);
}
console.log("\n  collection                     docs");
console.log("  ---------------------------------------");
let total = 0;
for (const [c, list] of Object.entries(byCollection).sort()) {
  total += list.length;
  console.log(`  ${c.padEnd(28)} ${String(list.length).padStart(6)}`);
}
console.log("  ---------------------------------------");
console.log(`  ${"TOTAL".padEnd(28)} ${String(total).padStart(6)}\n`);

if (!PROD) {
  mkdirSync(dirname(outPath), { recursive: true });
  const grouped = {};
  for (const wr of writes) {
    (grouped[wr.path] ||= {})[wr.id] = wr.data;
  }
  writeFileSync(outPath, JSON.stringify(grouped, null, 2));
  console.log(`  DRY RUN — wrote ${outPath}`);
  console.log(`  Review it, then re-run with --prod to load into ${PROJECT}.\n`);
  process.exit(0);
}

// --- production load ---------------------------------------------------
console.log(`  PROD LOAD -> Firestore project "${PROJECT}"`);
const admin = await import("firebase-admin").then((m) => m.default);
try {
  admin.initializeApp({ projectId: PROJECT });
} catch (e) {
  console.error(
    "\n  Could not initialise firebase-admin credentials.\n" +
    "  Provide a service account key:\n" +
    "    GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json npm run load:prod\n" +
    `  (Firebase console -> Project settings -> Service accounts -> Generate key)\n\n  ${e.message}\n`
  );
  process.exit(1);
}
const db = admin.firestore();

let batch = db.batch();
let n = 0;
let done = 0;
for (const wr of writes) {
  const ref =
    wr.path.includes("/")
      ? db.collection(wr.path).doc(wr.id)
      : db.collection(wr.path).doc(wr.id);
  batch.set(ref, toFirestore(wr.data, admin), { merge: false });
  if (++n === 400) {
    await batch.commit();
    done += n;
    process.stdout.write(`\r  committed ${done}/${writes.length}`);
    batch = db.batch();
    n = 0;
  }
}
if (n) {
  await batch.commit();
  done += n;
}
process.stdout.write(`\r  committed ${done}/${writes.length}\n`);
console.log("  Done.\n");

function toFirestore(v, admin) {
  if (v instanceof Date) return admin.firestore.Timestamp.fromDate(v);
  if (Array.isArray(v)) return v.map((x) => toFirestore(x, admin));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = toFirestore(val, admin);
    return o;
  }
  return v;
}
