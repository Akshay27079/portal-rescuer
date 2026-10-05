/**
 * db.js — IndexedDB wrapper for Portal Rescuer.
 * Exposes: window.PortalRescuer.db
 *
 * Stores:
 *   snapshots  — full form state per page (keyPath: sessionKey)
 *   fields     — per-field values (keyPath: [sessionKey, fieldKey])
 *   retryJobs  — retry queue mirror (keyPath: id)
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.db = (() => {

  const DB_NAME          = "PortalRescuerDB";
  const DB_VERSION       = 1;
  const DEFAULT_MAX_DAYS = 30;

  let _dbPromise = null;

  // ── Open DB ────────────────────────────────────────────────────────────────

  function _open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains("snapshots")) {
          const ss = db.createObjectStore("snapshots", { keyPath: "sessionKey" });
          ss.createIndex("savedAt", "savedAt", { unique: false });
          ss.createIndex("pageUrl", "pageUrl", { unique: false });
        }
        if (!db.objectStoreNames.contains("fields")) {
          const fs = db.createObjectStore("fields", { keyPath: ["sessionKey", "fieldKey"] });
          fs.createIndex("sessionKey", "sessionKey", { unique: false });
          fs.createIndex("savedAt",    "savedAt",    { unique: false });
        }
        if (!db.objectStoreNames.contains("retryJobs")) {
          const rj = db.createObjectStore("retryJobs", { keyPath: "id" });
          rj.createIndex("status",      "status",      { unique: false });
          rj.createIndex("sessionKey",  "sessionKey",  { unique: false });
          rj.createIndex("nextRetryAt", "nextRetryAt", { unique: false });
        }
      };

      req.onsuccess = (evt) => {
        const db = evt.target.result;
        db.onversionchange = () => { db.close(); _dbPromise = null; };
        resolve(db);
      };

      req.onerror   = () => { _dbPromise = null; reject(req.error); };
      req.onblocked = () => console.warn("[PortalRescuer DB] Upgrade blocked.");
    });
    return _dbPromise;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _p(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  async function _tx(stores, mode, fn) {
    const db    = await _open();
    const names = Array.isArray(stores) ? stores : [stores];
    const txn   = db.transaction(names, mode);
    const map   = Object.fromEntries(names.map(n => [n, txn.objectStore(n)]));

    // Run fn, then wait for transaction to commit
    const result = await fn(map);
    await new Promise((res, rej) => {
      txn.oncomplete = res;
      txn.onerror    = () => rej(txn.error);
      txn.onabort    = () => rej(new Error("Transaction aborted"));
    });
    return result;
  }

  // Fixed cursor deletion — cursor.continue() does NOT return a Promise.
  // We must use the request pattern instead.
  function _deleteAllByCursor(store, index, range) {
    return new Promise((resolve, reject) => {
      const req = index.openCursor(range);
      req.onsuccess = (evt) => {
        const cursor = evt.target.result;
        if (!cursor) { resolve(); return; }
        cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  async function saveSnapshot(sessionKey, data) {
    const record = {
      sessionKey,
      snapshot:   data.snapshot   || {},
      pageTitle:  data.pageTitle  || "",
      pageUrl:    data.pageUrl    || "",
      savedAt:    data.savedAt    || Date.now(),
      fieldCount: Object.keys(data.snapshot || {}).length,
    };
    await _tx("snapshots", "readwrite", ({ snapshots }) => _p(snapshots.put(record)));
    // Mirror to chrome.storage.local for SW and popup access
    try { chrome.storage.local.set({ [`pr_snapshot_${sessionKey}`]: record }); } catch (_) {}
  }

  async function loadSnapshot(sessionKey) {
    const r = await _tx("snapshots", "readonly", ({ snapshots }) => _p(snapshots.get(sessionKey)));
    return r ?? null;
  }

  async function deleteSnapshot(sessionKey) {
    await _tx(["snapshots", "fields"], "readwrite", async ({ snapshots, fields }) => {
      await _p(snapshots.delete(sessionKey));
      await _deleteAllByCursor(fields, fields.index("sessionKey"), IDBKeyRange.only(sessionKey));
    });
    try { chrome.storage.local.remove(`pr_snapshot_${sessionKey}`); } catch (_) {}
  }

  async function getAllSnapshots() {
    const rows = await _tx("snapshots", "readonly", ({ snapshots }) => _p(snapshots.getAll()));
    return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  async function countSnapshots() {
    return _tx("snapshots", "readonly", ({ snapshots }) => _p(snapshots.count()));
  }

  // ── Fields ─────────────────────────────────────────────────────────────────

  async function saveField(sessionKey, fieldKey, value) {
    await _tx("fields", "readwrite", ({ fields }) =>
      _p(fields.put({ sessionKey, fieldKey, value, savedAt: Date.now() }))
    );
  }

  async function loadFields(sessionKey) {
    const rows = await _tx("fields", "readonly", ({ fields }) =>
      _p(fields.index("sessionKey").getAll(IDBKeyRange.only(sessionKey)))
    );
    return Object.fromEntries((rows || []).map(r => [r.fieldKey, r.value]));
  }

  // ── Retry jobs ─────────────────────────────────────────────────────────────

  async function saveRetryJob(job) {
    await _tx("retryJobs", "readwrite", ({ retryJobs }) => _p(retryJobs.put(job)));
  }

  async function getRetryJobs(status = null) {
    return _tx("retryJobs", "readonly", ({ retryJobs }) => {
      if (status) return _p(retryJobs.index("status").getAll(IDBKeyRange.only(status)));
      return _p(retryJobs.getAll());
    });
  }

  async function deleteRetryJob(id) {
    await _tx("retryJobs", "readwrite", ({ retryJobs }) => _p(retryJobs.delete(id)));
  }

  async function clearFinishedJobs() {
    await _tx("retryJobs", "readwrite", async ({ retryJobs }) => {
      for (const s of ["succeeded", "cancelled", "failed"]) {
        await _deleteAllByCursor(retryJobs, retryJobs.index("status"), IDBKeyRange.only(s));
      }
    });
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  async function clearOldSnapshots(maxDays = DEFAULT_MAX_DAYS) {
    const cutoff = Date.now() - maxDays * 86_400_000;
    let deleted  = 0;

    await _tx(["snapshots", "fields"], "readwrite", async ({ snapshots, fields }) => {
      const old = await _p(snapshots.index("savedAt").getAll(IDBKeyRange.upperBound(cutoff)));
      for (const snap of (old || [])) {
        await _p(snapshots.delete(snap.sessionKey));
        await _deleteAllByCursor(fields, fields.index("sessionKey"), IDBKeyRange.only(snap.sessionKey));
        deleted++;
      }
    });

    if (deleted) console.info(`[PortalRescuer DB] Pruned ${deleted} old snapshots.`);
    return deleted;
  }

  async function getStats() {
    const [s, f, r] = await Promise.all([
      _tx("snapshots",  "readonly", ({ snapshots })  => _p(snapshots.count())),
      _tx("fields",     "readonly", ({ fields })     => _p(fields.count())),
      _tx("retryJobs",  "readonly", ({ retryJobs })  => _p(retryJobs.count())),
    ]);
    return { snapshots: s, fields: f, retryJobs: r };
  }

  async function nukeDatabase() {
    const db = await _open();
    db.close();
    _dbPromise = null;
    return new Promise((res, rej) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = res;
      req.onerror   = () => rej(req.error);
    });
  }

  // Eager open + prune on load
  _open()
    .then(() => clearOldSnapshots())
    .catch(e => console.warn("[PortalRescuer DB] Init error:", e));

  return {
    saveSnapshot, loadSnapshot, deleteSnapshot, getAllSnapshots, countSnapshots,
    saveField, loadFields,
    saveRetryJob, getRetryJobs, deleteRetryJob, clearFinishedJobs,
    clearOldSnapshots, getStats, nukeDatabase,
  };
})();
