/**
 * autosave.js — The auto-save engine.
 *
 * Responsibilities:
 *  1. Attach input listeners to every discovered field.
 *  2. Debounce-save field values to IndexedDB (via window.PortalRescuer.db).
 *  3. Periodically flush a full snapshot (heartbeat).
 *  4. Broadcast save events to the background service worker.
 *  5. Re-attach listeners when new fields appear (dynamic pages).
 *
 * Exposes: window.PortalRescuer.autosave
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.autosave = (() => {

  const { getPageKey, debounce, isSensitiveField } = window.PortalRescuer.helpers;
  const { scanPage, watchForNewFields, readValue }  = window.PortalRescuer.scanner;

  /** How often (ms) to do a full heartbeat snapshot regardless of changes */
  const HEARTBEAT_INTERVAL = 15_000;  // 15 seconds

  /** Debounce delay (ms) after user stops typing before saving that field */
  const DEBOUNCE_DELAY = 600;

  let _sessionKey   = null;   // stable key for this page URL
  let _snapshot     = {};     // { fieldKey: value } — in-memory mirror
  let _fieldMap     = new Map(); // fieldKey → FieldDescriptor
  let _listeners    = new Map(); // element → handler (for cleanup)
  let _heartbeatId  = null;
  let _dirty        = false;  // true when snapshot has unsaved changes
  let _initialized  = false;

  /** ── PUBLIC: initialise the autosave engine ── */
  function init() {
    if (_initialized) return;
    _initialized = true;
    _sessionKey = getPageKey();

    _attachToAllFields();
    _startHeartbeat();
    _watchNewFields();

    // Save on page unload as a last resort
    window.addEventListener("beforeunload", _flushNow);
    window.addEventListener("pagehide",     _flushNow);

    console.debug("[PortalRescuer] Autosave initialised for:", _sessionKey);
  }

  /** ── Scan the page and attach listeners to every field ── */
  function _attachToAllFields() {
    const fields = scanPage();
    fields.forEach(_attachField);
    console.debug(`[PortalRescuer] Attached autosave to ${fields.length} fields.`);
  }

  /** ── Attach a debounced save listener to a single field descriptor ── */
  function _attachField(fd) {
    if (_listeners.has(fd.element)) return; // already watched

    // Read existing value into snapshot immediately (page may have pre-filled data)
    const initial = readValue(fd);
    if (initial !== null && initial !== undefined && initial !== "") {
      _snapshot[fd.key] = initial;
      _dirty = true;
    }

    _fieldMap.set(fd.key, fd);

    const handler = debounce(() => {
      if (isSensitiveField(fd.element)) return;
      const val = readValue(fd);
      if (val === _snapshot[fd.key]) return; // no change
      _snapshot[fd.key] = val;
      _dirty = true;
      _saveField(fd.key, val);
    }, DEBOUNCE_DELAY);

    const events = ["input", "change"];
    events.forEach(evt => fd.element.addEventListener(evt, handler));
    _listeners.set(fd.element, { handler, events });
  }

  /** ── Persist a single field immediately ── */
  async function _saveField(key, value) {
    window.dispatchEvent(new CustomEvent("pr:saving"));
    try {
      await window.PortalRescuer.db.saveField(_sessionKey, key, value);
      window.dispatchEvent(new CustomEvent("pr:saved"));
      _notifyBackground("FIELD_SAVED", { sessionKey: _sessionKey, key, ts: Date.now() });
    } catch (err) {
      console.warn("[PortalRescuer] Field save failed:", err);
      window.dispatchEvent(new CustomEvent("pr:error"));
    }
  }

  /** ── Flush the entire snapshot to DB ── */
  async function _flushSnapshot() {
    if (!_dirty) return;
    _dirty = false;
    try {
      await window.PortalRescuer.db.saveSnapshot(_sessionKey, {
        snapshot:  _snapshot,
        pageTitle: document.title,
        pageUrl:   location.href,
        savedAt:   Date.now(),
      });
      _notifyBackground("SNAPSHOT_SAVED", { sessionKey: _sessionKey, ts: Date.now() });
      console.debug("[PortalRescuer] Snapshot saved.");
    } catch (err) {
      console.warn("[PortalRescuer] Snapshot flush failed:", err);
      _dirty = true; // mark dirty again so heartbeat retries
    }
  }

  /** ── Synchronous best-effort flush (beforeunload) ── */
  function _flushNow() {
    // Use Chrome storage sync as a last-resort fallback (small payload)
    if (!_dirty) return;
    try {
      const payload = {
        snapshot:  _snapshot,
        pageTitle: document.title,
        pageUrl:   location.href,
        savedAt:   Date.now(),
      };
      chrome.storage.local.set({ [`pr_emergency_${_sessionKey}`]: payload });
    } catch (e) { /* silently ignore — we already have the heartbeat */ }
  }

  /** ── Start the periodic heartbeat flush ── */
  function _startHeartbeat() {
    _heartbeatId = setInterval(_flushSnapshot, HEARTBEAT_INTERVAL);
  }

  /** ── Watch for dynamically added fields ── */
  function _watchNewFields() {
    watchForNewFields((newFields) => {
      newFields.forEach(_attachField);
      console.debug(`[PortalRescuer] Attached ${newFields.length} new dynamic fields.`);
    });
  }

  /** ── Send a message to the background service worker ── */
  function _notifyBackground(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload });
    } catch (e) { /* extension context may be invalidated on hot reload */ }
  }

  /** ── PUBLIC: force an immediate flush (called by main.js on submit intercept) ── */
  async function forceFlush() {
    _dirty = true;
    await _flushSnapshot();
  }

  /** ── PUBLIC: get the current in-memory snapshot ── */
  function getSnapshot() {
    return { ..._snapshot };
  }

  /** ── PUBLIC: get the current session key ── */
  function getSessionKey() {
    return _sessionKey;
  }

  /** ── PUBLIC: tear down listeners (for testing / cleanup) ── */
  function destroy() {
    clearInterval(_heartbeatId);
    _listeners.forEach(({ handler, events }, element) => {
      events.forEach(evt => element.removeEventListener(evt, handler));
    });
    _listeners.clear();
    _fieldMap.clear();
    _snapshot = {};
    _dirty = false;
    _initialized = false;
    window.removeEventListener("beforeunload", _flushNow);
    window.removeEventListener("pagehide",     _flushNow);
  }

  return { init, forceFlush, getSnapshot, getSessionKey, destroy };
})();
