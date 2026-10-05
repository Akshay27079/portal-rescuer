/**
 * main.js — Content script entry point.
 * Runs last in the load order.
 */

window.PortalRescuer = window.PortalRescuer || {};

(async () => {
  if (window.PortalRescuer._ready) return;
  window.PortalRescuer._ready = true;

  const { autosave, refill, overlay } = window.PortalRescuer;

  // 1. Restore any previously saved session
  await refill.restore();

  // 2. Start auto-saving
  autosave.init();

  // 3. Intercept form submissions
  _watchForms();

  // 4. Handle messages from popup / background
  chrome.runtime.onMessage.addListener(_onMessage);

  // 5. SPA navigation
  window.addEventListener("hashchange", _onNav);
  window.addEventListener("popstate",   _onNav);

  console.info("[PortalRescuer] Ready on:", location.href);

  // ──────────────────────────────────────────────────────────────────────────

  const _seen = new WeakSet();

  function _watchForms() {
    document.querySelectorAll("form").forEach(_addSubmit);
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === "FORM") _addSubmit(n);
          n.querySelectorAll?.("form").forEach(_addSubmit);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function _addSubmit(form) {
    if (_seen.has(form)) return;
    _seen.add(form);
    form.addEventListener("submit", async () => {
      await autosave.forceFlush();
      try {
        chrome.runtime.sendMessage({
          type:       "FORM_SUBMITTED",
          sessionKey: autosave.getSessionKey(),
          formAction: form.action,
          formMethod: form.method || "GET",
          snapshot:   autosave.getSnapshot(),
          ts:         Date.now(),
        });
      } catch (_) {}
    }, { capture: true });
  }

  function _onMessage(msg, _sender, respond) {
    switch (msg.type) {
      case "GET_STATUS":
        respond({
          sessionKey: autosave.getSessionKey(),
          snapshot:   autosave.getSnapshot(),
          pageTitle:  document.title,
          pageUrl:    location.href,
          lastSaved:  autosave.getLastSaved?.() ?? null,
        });
        break;

      case "FORCE_REFILL":
        refill.fillFromSnapshot(msg.snapshot).then(respond);
        return true;

      case "DISCARD_SESSION":
        refill.discardSession(msg.sessionKey).then(() => respond({ ok: true }));
        return true;

      case "SHOW_OVERLAY":
        overlay?.showPanel();
        respond({ ok: true });
        break;

      case "HIDE_OVERLAY":
        overlay?.hidePanel();
        respond({ ok: true });
        break;

      case "REPLAY_SUBMISSION":
        // Background asked us to replay — re-fill and re-submit the form
        refill.fillFromSnapshot(msg.snapshot).then(() => {
          const form = document.querySelector("form");
          if (form) form.submit();
        });
        respond({ ok: true });
        break;

      default:
        respond({ ok: false });
    }
  }

  async function _onNav() {
    await new Promise(r => setTimeout(r, 800));
    autosave.destroy();
    window.PortalRescuer._ready = false;
    await refill.restore();
    autosave.init();
    _watchForms();
    window.PortalRescuer._ready = true;
  }
})();
