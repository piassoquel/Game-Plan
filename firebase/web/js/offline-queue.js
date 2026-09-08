// Generic offline write queue. Callable Cloud Functions don't work offline, so
// eligible writes (status changes, job details, build toggles) are captured in
// IndexedDB when there's no connection and replayed, in order, on reconnect.
// PIN entry happens at replay time, not capture time.

const DB_NAME = "gameplan-write-queue-v1";
const STORE = "writes";

function openDb() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error("Offline storage is unavailable on this device."));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function looksOffline(error) {
  if (!self.navigator?.onLine) return true;
  const msg = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || "");
  return code === "functions/unavailable" ||
    /network|failed to fetch|internet|offline|load failed|deadline/.test(msg);
}

export async function enqueue(type, args) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type, args, queuedAt: new Date().toISOString(),
  };
  await tx("readwrite", (s) => s.add(entry));
  return entry;
}

export async function pending() {
  const items = await tx("readonly", (s) => s.getAll());
  return (items || []).sort((a, b) => a.id.localeCompare(b.id));
}

export async function count() {
  try { return (await pending()).length; } catch { return 0; }
}

async function remove(id) {
  await tx("readwrite", (s) => s.delete(id));
}

/**
 * Replay every queued write via `handlers[type](args)`. Stops on the first
 * failure that still looks offline (keeps the item); drops items whose handler
 * throws a real (server) error after surfacing it via onError.
 * Returns { done, failed, remaining }.
 */
export async function flush(handlers, { onError } = {}) {
  const items = await pending();
  let done = 0;
  for (const item of items) {
    const handler = handlers[item.type];
    if (!handler) { await remove(item.id); continue; }
    try {
      await handler(item.args);
      await remove(item.id);
      done++;
    } catch (error) {
      if (looksOffline(error)) return { done, failed: 0, remaining: items.length - done };
      onError?.(item, error);
      await remove(item.id); // real error — don't retry forever
      return { done, failed: 1, remaining: items.length - done - 1 };
    }
  }
  return { done, failed: 0, remaining: 0 };
}
