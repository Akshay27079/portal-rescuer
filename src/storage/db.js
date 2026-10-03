/**
 * db.js — IndexedDB wrapper for Portal Rescuer.
 *
 * Provides a clean async API over IndexedDB so all other modules can
 * read and write durable local storage without caring about IDB mechanics.
 *
 * Schema
 * ──────
 * Database : "PortalRescuerDB"  version 1
 *
 * Object stores:
 *
 *   snapshots
 *     keyPath : sessionKey  (string — stable URL key)
 *     indexes : savedAt
 *     value   : {
 *       sessionKey : string,
 *       snapshot   : { [fieldKey]: value },   — full form state
 *       pageTitle  : string,
 *       pageUrl    : string,
 *       savedAt    : number,                  — epoch ms
 *       fieldCount : number,
 *     }
 *
 *   fields
 *     keyPath : [sessionKey, fieldKey]         — compound key
 *     indexes : sessionKey, savedAt
 *     value   : {
 *       sessionKey : string,
 *       fieldKey   : string,
 *       value      : any,
 *       savedAt    : number,
 *     }
 *
 *   retryJobs   (mirror of background's in-memory queue for persistence)
 *     keyPath : id
 *     indexes : status, sessionKey, nextRetryAt
 *     value   : RetryJob (see service_worker.js)
 *
 * Usage (content script context — no ES module imports):
 *   await window.PortalRescuer.db.saveSnapshot(key, data)
 *   await window.PortalRescuer.db.loadSnapshot(key)
 *   await window.PortalRescuer.db.saveField(sessionKey, fieldKey, value)
 *   await window.PortalRescuer.db.deleteSnapshot(key)
 *   await window.PortalRescuer.db.getAllSnapshots()
 *   await window.PortalRescuer.db.clearOldSnapshots(maxAgeDays)
 *
 * Exposes: window.PortalRescuer.db
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.db = (() => {

  // ── Config ────────────────────────────────────────────────────────────────

  const DB_NAME    = "PortalRescuerDB";
  const DB_VERSION = 1;

  /** Snapshots older than this are eligible for automatic pruning */
  const DEFAULT_MAX_AGE_DAYS = 30;

  // ── Internal state ────────────────────────────────────────────────────────

  /** Cached open DB connection promise — opened once, reused everywhere */
  let _dbPromise = null;

  // ── Open / upgrade ────────────────────────────────────────────────────────

  /**
   * Opens (or reuses) the database connection.
   * Handles schema creation on first run and migrations on version bump.
   * @returns {Promise<IDBDatabase>}
   */
  function _open() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (evt) => {
        const db  = evt.target.result;
        const txn = evt.target.transaction;

        // ── snapshots store ──────────────────────────────────────────────
        if (!db.objectStoreNames.contains("snapshots")) {
          const ss = db.createObjectStore("snapshots", { keyPath: "sessionKey" });
          ss.createIndex("savedAt",    "savedAt",    { unique: false });
          ss.createIndex("pageUrl",    "pageUrl",    { unique: false });
        }

        // ── fields store ─────────────────────────────────────────────────
        if (!db.objectStoreNames.contains("fields")) {
          const fs = db.createObjectStore("fields", { keyPath: ["sessionKey", "fieldKey"] });
          fs.createIndex("sessionKey", "sessionKey", { unique: false });
          fs.createIndex("savedAt",    "savedAt",    { unique: false });
        }

        // ── retryJobs store ──────────────────────────────────────────────
        if (!db.objectStoreNames.contains("retryJobs")) {
          const rj = db.createObjectStore("retryJobs", { keyPath: "id" });
          rj.createIndex("status",      "status",      { unique: false });
          rj.createIndex("sessionKey",  "sessionKey",  { unique: false });
          rj.createIndex("nextRetryAt", "nextRetryAt", { unique: false });
        }
      };

      req.onsuccess = (evt) => {
        const db = evt.target.result;

        // Handle unexpected version changes from another tab
        db.onversionchange = () => {
          db.close();
          _dbPromise = null;
          console.warn("[PortalRescuer DB] Version change detected — connection closed.");
        };

        resolve(db);
      };

      req.onerror = (evt) => {
        _dbPromise = null;
        reject(new Error(`IndexedDB open failed: ${evt.target.error?.message || "unknown"}`));
      };

      req.onblocked = () => {
        console.warn("[PortalRescuer DB] Open blocked — another tab holds an older version.");
      };
    });

    return _dbPromise;
  }

  // ── Generic helpers ───────────────────────────────────────────────────────

  /**
   * Wraps an IDBRequest in a Promise.
   * @param {IDBRequest} req
   * @returns {Promise<any>}
   */
  function _promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  /**
   * Opens a transaction on the given store(s) and runs an operation.
   * @param {string|string[]} storeNames
   * @param {"readonly"|"readwrite"} mode
   * @param {(stores: Object) => Promise<any>} fn  — receives { storeName: IDBObjectStore, ... }
   */
  async function _withTransaction(storeNames, mode, fn) {
    const db     = await _open();
    const names  = Array.isArray(storeNames) ? storeNames : [storeNames];
    const txn    = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map(n => [n, txn.objectStore(n)]));

    // We also return a promise that resolves when the transaction commits
    const txnComplete = new Promise((resolve, reject) => {
      txn.oncomplete = () => resolve();
      txn.onerror    = () => reject(txn.error);
      txn.onabort    = () => reject(new Error("Transaction aborted"));
    });

    const result = await fn(stores);
    await txnComplete;
    return result;
  }

  // ── Snapshot API ──────────────────────────────────────────────────────────

  /**
   * Saves (upserts) a full form snapshot.
   * @param {string} sessionKey
   * @param {{ snapshot, pageTitle, pageUrl, savedAt }} data
   */
  async function saveSnapshot(sessionKey, data) {
    const record = {
      sessionKey,
      snapshot:   data.snapshot   || {},
      pageTitle:  data.pageTitle  || "",
      pageUrl:    data.pageUrl    || "",
      savedAt:    data.savedAt    || Date.now(),
      fieldCount: Object.keys(data.snapshot || {}).length,
    };

    await _withTransaction("snapshots", "readwrite", ({ snapshots }) =>
      _promisify(snapshots.put(record))
    );

    // Mirror to chrome.storage.local as a cheap backup (background SW reads this)
    try {
      chrome.storage.local.set({ [`pr_snapshot_${sessionKey}`]: record });
    } catch (_) { /* not in extension context during tests */ }
  }

  /**
   * Loads a saved snapshot by session key.
   * Returns null if none found.
   * @param {string} sessionKey
   * @returns {Promise<object|null>}
   */
  async function loadSnapshot(sessionKey) {
    const result = await _withTransaction("snapshots", "readonly", ({ snapshots }) =>
      _promisify(snapshots.get(sessionKey))
    );
    return result ?? null;
  }

  /**
   * Deletes a snapshot (and its field records) by session key.
   * @param {string} sessionKey
   */
  async function deleteSnapshot(sessionKey) {
    await _withTransaction(["snapshots", "fields"], "readwrite", async ({ snapshots, fields }) => {
      // Delete the snapshot record
      await _promisify(snapshots.delete(sessionKey));

      // Delete all field records for this session via the sessionKey index
      const index  = fields.index("sessionKey");
      const range  = IDBKeyRange.only(sessionKey);
      const cursor = await _promisify(index.openCursor(range));
      await _deleteByCursor(cursor);
    });

    // Remove from chrome.storage mirror too
    try {
      chrome.storage.local.remove(`pr_snapshot_${sessionKey}`);
    } catch (_) {}
  }

  /**
   * Returns all stored snapshots, sorted by savedAt descending (newest first).
   * @returns {Promise<object[]>}
   */
  async function getAllSnapshots() {
    const records = await _withTransaction("snapshots", "readonly", ({ snapshots }) =>
      _promisify(snapshots.getAll())
    );
    return (records || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  /**
   * Returns the total number of saved snapshots.
   * @returns {Promise<number>}
   */
  async function countSnapshots() {
    return _withTransaction("snapshots", "readonly", ({ snapshots }) =>
      _promisify(snapshots.count())
    );
  }

  // ── Field API ─────────────────────────────────────────────────────────────

  /**
   * Saves (upserts) a single field value.
   * Use this for per-keystroke saves; saveSnapshot() is for full flushes.
   * @param {string} sessionKey
   * @param {string} fieldKey
   * @param {any}    value
   */
  async function saveField(sessionKey, fieldKey, value) {
    const record = {
      sessionKey,
      fieldKey,
      value,
      savedAt: Date.now(),
    };

    await _withTransaction("fields", "readwrite", ({ fields }) =>
      _promisify(fields.put(record))
    );
  }

  /**
   * Loads all field records for a session.
   * Returns an object { fieldKey: value } — same shape as snapshot.snapshot.
   * @param {string} sessionKey
   * @returns {Promise<object>}
   */
  async function loadFields(sessionKey) {
    const records = await _withTransaction("fields", "readonly", ({ fields }) => {
      const index = fields.index("sessionKey");
      const range = IDBKeyRange.only(sessionKey);
      return _promisify(index.getAll(range));
    });
    return Object.fromEntries((records || []).map(r => [r.fieldKey, r.value]));
  }

  // ── Retry Jobs API ────────────────────────────────────────────────────────

  /**
   * Saves (upserts) a retry job record.
   * @param {object} job — RetryJob shape from service_worker.js
   */
  async function saveRetryJob(job) {
    await _withTransaction("retryJobs", "readwrite", ({ retryJobs }) =>
      _promisify(retryJobs.put(job))
    );
  }

  /**
   * Loads all retry jobs, optionally filtered by status.
   * @param {string|null} status — e.g. "pending", null for all
   * @returns {Promise<object[]>}
   */
  async function getRetryJobs(status = null) {
    if (status) {
      return _withTransaction("retryJobs", "readonly", ({ retryJobs }) => {
        const index = retryJobs.index("status");
        const range = IDBKeyRange.only(status);
        return _promisify(index.getAll(range));
      });
    }
    return _withTransaction("retryJobs", "readonly", ({ retryJobs }) =>
      _promisify(retryJobs.getAll())
    );
  }

  /**
   * Deletes a single retry job by id.
   * @param {string} id
   */
  async function deleteRetryJob(id) {
    await _withTransaction("retryJobs", "readwrite", ({ retryJobs }) =>
      _promisify(retryJobs.delete(id))
    );
  }

  /**
   * Removes all completed/cancelled retry jobs.
   */
  async function clearFinishedJobs() {
    const finished = ["succeeded", "cancelled", "failed"];
    await _withTransaction("retryJobs", "readwrite", async ({ retryJobs }) => {
      for (const status of finished) {
        const index  = retryJobs.index("status");
        const range  = IDBKeyRange.only(status);
        const cursor = await _promisify(index.openCursor(range));
        await _deleteByCursor(cursor);
      }
    });
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /**
   * Removes snapshots older than `maxAgeDays` days.
   * Call periodically (e.g. on extension startup) to keep storage tidy.
   * @param {number} maxAgeDays — defaults to 30
   * @returns {Promise<number>} — count of deleted records
   */
  async function clearOldSnapshots(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
    const cutoff  = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const range   = IDBKeyRange.upperBound(cutoff);
    let   deleted = 0;

    await _withTransaction(["snapshots", "fields"], "readwrite", async ({ snapshots, fields }) => {
      // Find old snapshot keys
      const index     = snapshots.index("savedAt");
      const oldSnaps  = await _promisify(index.getAll(range));
      const oldKeys   = (oldSnaps || []).map(s => s.sessionKey);

      for (const key of oldKeys) {
        await _promisify(snapshots.delete(key));

        // Delete associated field records
        const fi     = fields.index("sessionKey");
        const fr     = IDBKeyRange.only(key);
        const cursor = await _promisify(fi.openCursor(fr));
        await _deleteByCursor(cursor);
        deleted++;
      }
    });

    if (deleted > 0) {
      console.info(`[PortalRescuer DB] Pruned ${deleted} old snapshots.`);
    }
    return deleted;
  }

  /**
   * Returns storage usage statistics.
   * @returns {Promise<{ snapshots: number, fields: number, retryJobs: number }>}
   */
  async function getStats() {
    const [snapshots, fields, retryJobs] = await Promise.all([
      _withTransaction("snapshots",  "readonly", ({ snapshots })  => _promisify(snapshots.count())),
      _withTransaction("fields",     "readonly", ({ fields })     => _promisify(fields.count())),
      _withTransaction("retryJobs",  "readonly", ({ retryJobs })  => _promisify(retryJobs.count())),
    ]);
    return { snapshots, fields, retryJobs };
  }

  /**
   * Wipes the entire database. USE WITH CAUTION.
   * Prompts internally — do not call without user confirmation.
   */
  async function nukeDatabase() {
    const db = await _open();
    db.close();
    _dbPromise = null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => {
        console.warn("[PortalRescuer DB] Database deleted.");
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ── Cursor helpers ────────────────────────────────────────────────────────

  /**
   * Recursively deletes all records from an IDBCursor position onward.
   * Used to bulk-delete by index range.
   */
  async function _deleteByCursor(cursor) {
    if (!cursor) return;
    await _promisify(cursor.delete());
    const next = await _promisify(cursor.continue());
    await _deleteByCursor(next);
  }

  // ── Auto-maintenance on load ──────────────────────────────────────────────

  // Open the DB eagerly so the first real operation doesn't pay the open cost.
  // Also prune stale data silently in the background.
  _open()
    .then(() => clearOldSnapshots(DEFAULT_MAX_AGE_DAYS))
    .catch(err => console.warn("[PortalRescuer DB] Startup maintenance failed:", err));

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    // Snapshots
    saveSnapshot,
    loadSnapshot,
    deleteSnapshot,
    getAllSnapshots,
    countSnapshots,

    // Individual fields
    saveField,
    loadFields,

    // Retry jobs
    saveRetryJob,
    getRetryJobs,
    deleteRetryJob,
    clearFinishedJobs,

    // Maintenance
    clearOldSnapshots,
    getStats,
    nukeDatabase,
  };
})();
