/**
 * autosave.js — Auto-save engine.
 * Debounce-saves every field change to IndexedDB.
 * Heartbeat flushes full snapshot every 15s.
 * Fires pr:saving / pr:saved / pr:error custom events for the overlay.
 * Exposes: window.PortalRescuer.autosave
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.autosave = (() => {

  const { getPageKey, debounce, isSensitiveField } = window.PortalRescuer.helpers;
  const { scanPage, watchForNewFields, readValue }  = window.PortalRescuer.scanner;

  const HEARTBEAT_MS = 15_000;
  const DEBOUNCE_MS  = 600;

  let _key         = null;
  let _snapshot    = {};
  let _fieldMap    = new Map();
  let _listeners   = new Map();
  let _heartbeatId = null;
  let _dirty       = false;
  let _initialized = false;
  let _lastSavedAt = null;

  // ── Public API ─────────────────────────────────────────────────────────────

  function init() {
    if (_initialized) return;
    _initialized = true;
    _key = getPageKey();

    _attachAll();
    _startHeartbeat();
    _watchNew();

    window.addEventListener("beforeunload", _emergencyFlush);
    window.addEventListener("pagehide",     _emergencyFlush);

    console.debug("[PortalRescuer] Autosave ready:", _key);
  }

  async function forceFlush() {
    _dirty = true;
    await _flush();
  }

  function getSnapshot()   { return { ..._snapshot }; }
  function getSessionKey() { return _key; }
  function getLastSaved()  { return _lastSavedAt; }

  function destroy() {
    clearInterval(_heartbeatId);
    _listeners.forEach(({ handler, events }, el) => {
      events.forEach(evt => el.removeEventListener(evt, handler));
    });
    _listeners.clear();
    _fieldMap.clear();
    _snapshot    = {};
    _dirty       = false;
    _initialized = false;
    _lastSavedAt = null;
    window.removeEventListener("beforeunload", _emergencyFlush);
    window.removeEventListener("pagehide",     _emergencyFlush);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  function _attachAll() {
    const fields = scanPage();
    fields.forEach(_attachField);
    console.debug(`[PortalRescuer] Watching ${fields.length} fields.`);
  }

  function _attachField(fd) {
    if (_listeners.has(fd.element)) return;

    // Capture existing value
    const initial = readValue(fd);
    if (initial !== null && initial !== undefined && initial !== "") {
      _snapshot[fd.key] = initial;
      _dirty = true;
    }
    _fieldMap.set(fd.key, fd);

    const handler = debounce(() => {
      if (isSensitiveField(fd.element)) return;
      const val = readValue(fd);
      if (val === _snapshot[fd.key]) return;
      _snapshot[fd.key] = val;
      _dirty = true;
      _saveField(fd.key, val);
    }, DEBOUNCE_MS);

    const events = ["input", "change"];
    events.forEach(evt => fd.element.addEventListener(evt, handler));
    _listeners.set(fd.element, { handler, events });
  }

  async function _saveField(key, value) {
    _fire("pr:saving");
    try {
      await window.PortalRescuer.db.saveField(_key, key, value);
      _lastSavedAt = Date.now();
      _fire("pr:saved");
      _msg("FIELD_SAVED", { sessionKey: _key, key, ts: _lastSavedAt });
    } catch (err) {
      console.warn("[PortalRescuer] Field save failed:", err);
      _fire("pr:error");
    }
  }

  async function _flush() {
    if (!_dirty) return;
    _dirty = false;
    try {
      const savedAt = Date.now();
      await window.PortalRescuer.db.saveSnapshot(_key, {
        snapshot:  _snapshot,
        pageTitle: document.title,
        pageUrl:   location.href,
        savedAt,
      });
      _lastSavedAt = savedAt;
      _fire("pr:saved");
      _msg("SNAPSHOT_SAVED", { sessionKey: _key, ts: savedAt });
      console.debug("[PortalRescuer] Snapshot saved.");
    } catch (err) {
      console.warn("[PortalRescuer] Snapshot flush failed:", err);
      _dirty = true; // retry on next heartbeat
    }
  }

  function _emergencyFlush() {
    if (!_dirty) return;
    try {
      chrome.storage.local.set({
        [`pr_emergency_${_key}`]: {
          snapshot:  _snapshot,
          pageTitle: document.title,
          pageUrl:   location.href,
          savedAt:   Date.now(),
        }
      });
    } catch (_) {}
  }

  function _startHeartbeat() {
    _heartbeatId = setInterval(_flush, HEARTBEAT_MS);
  }

  function _watchNew() {
    watchForNewFields((fields) => {
      fields.forEach(_attachField);
      console.debug(`[PortalRescuer] ${fields.length} new fields attached.`);
    });
  }

  function _fire(name) {
    window.dispatchEvent(new CustomEvent(name));
  }

  function _msg(type, payload) {
    try { chrome.runtime.sendMessage({ type, ...payload }); } catch (_) {}
  }

  return { init, forceFlush, getSnapshot, getSessionKey, getLastSaved, destroy };
})();
