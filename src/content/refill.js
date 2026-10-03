/**
 * refill.js — Session recovery & field refill engine.
 *
 * On page load, checks IndexedDB for a saved snapshot matching this URL.
 * If found, refills every form field with the saved value and shows a
 * recovery banner via the overlay module.
 *
 * Handles:
 *  - Text / email / tel / number / URL / date inputs
 *  - Textareas
 *  - <select> (single and multi)
 *  - Checkboxes and radio buttons
 *  - contenteditable elements
 *  - React / Angular / Vue (dispatches synthetic events)
 *  - Fields that appear late (waits up to MAX_WAIT_MS for them)
 *
 * Exposes: window.PortalRescuer.refill
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.refill = (() => {

  const { getPageKey, dispatchInputEvents, isVisible } = window.PortalRescuer.helpers;
  const { scanPage, watchForNewFields }                = window.PortalRescuer.scanner;

  /** Maximum time (ms) to wait for fields to appear after load */
  const MAX_WAIT_MS    = 8_000;
  /** How often (ms) to retry filling fields that weren't yet in the DOM */
  const RETRY_INTERVAL = 500;

  let _pendingRefills = {}; // fieldKey → value for fields not yet in DOM
  let _retryTimer     = null;
  let _retryElapsed   = 0;

  /** ── PUBLIC: attempt to restore a saved session on this page ── */
  async function restore() {
    const sessionKey = getPageKey();
    let saved;

    // Try IndexedDB first
    try {
      saved = await window.PortalRescuer.db.loadSnapshot(sessionKey);
    } catch (e) {
      console.warn("[PortalRescuer] DB load failed, checking emergency storage.", e);
    }

    // Fallback to emergency chrome.storage entry
    if (!saved) {
      try {
        const emergencyKey = `pr_emergency_${sessionKey}`;
        saved = await new Promise(resolve => {
          chrome.storage.local.get(emergencyKey, res => resolve(res[emergencyKey] || null));
        });
      } catch (e) { /* ignore */ }
    }

    if (!saved || !saved.snapshot || Object.keys(saved.snapshot).length === 0) {
      console.debug("[PortalRescuer] No saved session found for this page.");
      return null; // nothing to restore
    }

    console.info(`[PortalRescuer] Restoring ${Object.keys(saved.snapshot).length} fields saved at`, new Date(saved.savedAt).toLocaleTimeString());

    const result = await _applySnapshot(saved.snapshot);

    // Show recovery banner with meta info
    if (window.PortalRescuer.overlay) {
      window.PortalRescuer.overlay.showRecoveryBanner({
        fieldCount: result.filled,
        savedAt:    saved.savedAt,
        pageTitle:  saved.pageTitle,
        onDismiss:  () => {},
        onDiscard:  () => discardSession(sessionKey),
      });
    }

    return result;
  }

  /** ── Fill all fields in the snapshot against the live DOM ── */
  async function _applySnapshot(snapshot) {
    const fields       = scanPage();
    const fieldByKey   = new Map(fields.map(fd => [fd.key, fd]));
    let   filled       = 0;
    let   skipped      = 0;

    _pendingRefills = {};

    for (const [key, value] of Object.entries(snapshot)) {
      if (value === null || value === undefined) continue;

      const fd = fieldByKey.get(key);
      if (fd) {
        _fillField(fd, value);
        filled++;
      } else {
        // Field not in DOM yet — queue it
        _pendingRefills[key] = value;
        skipped++;
      }
    }

    if (skipped > 0) {
      console.debug(`[PortalRescuer] ${skipped} fields queued for deferred refill.`);
      _startRetryLoop(snapshot);
    }

    return { filled, skipped };
  }

  /**
   * Writes a value into a field element.
   * Handles all input types and fires synthetic events for framework compat.
   */
  function _fillField(fd, value) {
    const el = fd.element;
    if (!el || !document.contains(el)) return false;

    try {
      switch (fd.type) {
        case "checkbox":
          el.checked = Boolean(value);
          break;

        case "radio":
          // Only check if value matches this radio's value
          if (el.value === String(value)) {
            el.checked = true;
          }
          break;

        case "select-multiple":
          if (Array.isArray(value)) {
            const valSet = new Set(value.map(String));
            Array.from(el.options).forEach(opt => {
              opt.selected = valSet.has(opt.value);
            });
          }
          break;

        default:
          if (el.contentEditable === "true" || el.contentEditable === "") {
            el.innerText = String(value);
          } else {
            // Native input value setter (works with React's controlled components)
            const nativeSetter = Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(el), "value"
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(el, String(value));
            } else {
              el.value = String(value);
            }
          }
          break;
      }

      dispatchInputEvents(el);
      _highlightRestored(el);
      return true;
    } catch (err) {
      console.warn(`[PortalRescuer] Failed to fill field "${fd.key}":`, err);
      return false;
    }
  }

  /** Briefly flash a green outline to show the user which fields were restored */
  function _highlightRestored(el) {
    el.classList.add("pr-restored");
    setTimeout(() => el.classList.remove("pr-restored"), 2500);
  }

  /** Retry filling pending fields that weren't in DOM at restore time */
  function _startRetryLoop(snapshot) {
    if (_retryTimer) return;
    _retryElapsed = 0;

    // Also hook the mutation observer for new fields
    const stopWatching = watchForNewFields((newFields) => {
      newFields.forEach(fd => {
        if (_pendingRefills.hasOwnProperty(fd.key)) {
          _fillField(fd, _pendingRefills[fd.key]);
          delete _pendingRefills[fd.key];
        }
      });
      if (Object.keys(_pendingRefills).length === 0) {
        clearInterval(_retryTimer);
        _retryTimer = null;
        stopWatching();
      }
    });

    _retryTimer = setInterval(() => {
      _retryElapsed += RETRY_INTERVAL;
      if (_retryElapsed >= MAX_WAIT_MS || Object.keys(_pendingRefills).length === 0) {
        clearInterval(_retryTimer);
        _retryTimer = null;
        stopWatching();
        if (Object.keys(_pendingRefills).length > 0) {
          console.warn("[PortalRescuer] Some fields could not be refilled (timed out):", Object.keys(_pendingRefills));
        }
        return;
      }

      const fields     = scanPage();
      const fieldByKey = new Map(fields.map(fd => [fd.key, fd]));
      for (const key of Object.keys(_pendingRefills)) {
        const fd = fieldByKey.get(key);
        if (fd) {
          _fillField(fd, _pendingRefills[key]);
          delete _pendingRefills[key];
        }
      }
    }, RETRY_INTERVAL);
  }

  /** ── PUBLIC: clear saved data for the current session ── */
  async function discardSession(sessionKey) {
    const key = sessionKey || getPageKey();
    try {
      await window.PortalRescuer.db.deleteSnapshot(key);
      await new Promise(resolve => {
        chrome.storage.local.remove(`pr_emergency_${key}`, resolve);
      });
      console.info("[PortalRescuer] Session discarded:", key);
    } catch (e) {
      console.warn("[PortalRescuer] Could not discard session:", e);
    }
  }

  /** ── PUBLIC: manually fill fields from an external snapshot object ── */
  async function fillFromSnapshot(snapshot) {
    return _applySnapshot(snapshot);
  }

  return { restore, discardSession, fillFromSnapshot };
})();
