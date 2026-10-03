/**
 * main.js — Content script entry point.
 *
 * Orchestrates the full lifecycle:
 *  1. Restore any previously saved session (refill).
 *  2. Start auto-save on all form fields.
 *  3. Intercept form submissions → flush + hand to background retry queue.
 *  4. Listen for messages from popup / background.
 *  5. Handle SPA navigation (hashchange / popstate).
 */

window.PortalRescuer = window.PortalRescuer || {};

(async () => {
  // Guard: only run once per frame
  if (window.PortalRescuer._mainLoaded) return;
  window.PortalRescuer._mainLoaded = true;

  const { getPageKey } = window.PortalRescuer.helpers;
  const autosave       = window.PortalRescuer.autosave;
  const refill         = window.PortalRescuer.refill;
  const overlay        = window.PortalRescuer.overlay;

  // ── Step 1: Restore saved session ──────────────────────────────────────
  await refill.restore();

  // ── Step 2: Start auto-save ────────────────────────────────────────────
  autosave.init();

  // ── Step 3: Intercept form submissions ────────────────────────────────
  _interceptForms();

  // ── Step 4: Listen for extension messages ─────────────────────────────
  chrome.runtime.onMessage.addListener(_handleMessage);

  // ── Step 5: SPA nav re-init ────────────────────────────────────────────
  window.addEventListener("hashchange",  _onNavChange);
  window.addEventListener("popstate",    _onNavChange);

  console.info("[PortalRescuer] Content script ready on:", location.href);

  // ────────────────────────────────────────────────────────────────────────

  /** Intercept all <form> submit events on the page */
  function _interceptForms() {
    // Current forms
    document.querySelectorAll("form").forEach(_addSubmitListener);

    // Future forms (dynamic portals add forms after load)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName === "FORM") _addSubmitListener(node);
          node.querySelectorAll?.("form").forEach(_addSubmitListener);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const _listenedForms = new WeakSet();

  function _addSubmitListener(form) {
    if (_listenedForms.has(form)) return;
    _listenedForms.add(form);

    form.addEventListener("submit", async (evt) => {
      // Flush the latest snapshot before the page navigates away
      await autosave.forceFlush();

      // Notify background to start monitoring for errors on the next page
      chrome.runtime.sendMessage({
        type:       "FORM_SUBMITTED",
        sessionKey: autosave.getSessionKey(),
        formAction: form.action,
        formMethod: form.method || "GET",
        snapshot:   autosave.getSnapshot(),
        ts:         Date.now(),
      });
    }, { capture: true }); // capture phase so we run before portal's own handlers
  }

  /** Handle messages from popup or background */
  function _handleMessage(msg, _sender, sendResponse) {
    switch (msg.type) {
      case "GET_STATUS":
        sendResponse({
          sessionKey: autosave.getSessionKey(),
          snapshot:   autosave.getSnapshot(),
          pageTitle:  document.title,
          pageUrl:    location.href,
        });
        break;

      case "FORCE_REFILL":
        refill.fillFromSnapshot(msg.snapshot).then(result => sendResponse(result));
        return true; // async response

      case "DISCARD_SESSION":
        refill.discardSession(msg.sessionKey).then(() => sendResponse({ ok: true }));
        return true;

      case "SHOW_OVERLAY":
        overlay?.showPanel();
        sendResponse({ ok: true });
        break;

      case "HIDE_OVERLAY":
        overlay?.hidePanel();
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
  }

  /** Re-run on SPA navigation */
  async function _onNavChange() {
    // Small delay for the new page to render
    await new Promise(r => setTimeout(r, 800));
    autosave.destroy();
    window.PortalRescuer._mainLoaded = false;
    // Re-bootstrap (re-entry point)
    await refill.restore();
    autosave.init();
    _interceptForms();
    window.PortalRescuer._mainLoaded = true;
  }
})();
