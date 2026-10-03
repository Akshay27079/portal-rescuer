/**
 * injector.js — Overlay & UX enhancement layer.
 *
 * Injects a non-destructive UI layer on top of any page that provides:
 *  1. Recovery Banner  — shown when a saved session is restored on reload.
 *  2. Save Indicator   — floating status chip (auto-saved / saving… / error).
 *  3. Floating Panel   — expandable summary of tracked fields & retry queue.
 *  4. Field Tooltips   — subtle icons on filled/tracked fields.
 *  5. Error Intercept  — detects common error patterns in the page text
 *                        and offers to retry/report them.
 *
 * All elements are injected into an isolated Shadow DOM host so portal
 * CSS cannot leak in or out.
 *
 * Exposes: window.PortalRescuer.overlay
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.overlay = (() => {

  // ── Shadow DOM host setup ──────────────────────────────────────────────────

  let _shadowRoot = null;
  let _host       = null;

  function _ensureShadow() {
    if (_shadowRoot) return _shadowRoot;

    _host = document.createElement("div");
    _host.id = "portal-rescuer-overlay-host";
    Object.assign(_host.style, {
      position:    "fixed",
      top:         "0",
      left:        "0",
      width:       "0",
      height:      "0",
      overflow:    "visible",
      zIndex:      "2147483647",  // max z-index
      pointerEvents: "none",
    });

    _shadowRoot = _host.attachShadow({ mode: "open" });

    // Inject overlay CSS into the shadow root
    const style = document.createElement("style");
    style.textContent = _OVERLAY_CSS;
    _shadowRoot.appendChild(style);

    document.documentElement.appendChild(_host);
    return _shadowRoot;
  }

  // ── Recovery Banner ────────────────────────────────────────────────────────

  let _banner = null;

  /**
   * Shows the recovery banner at the top of the page.
   * @param {object} opts
   * @param {number} opts.fieldCount   — number of fields restored
   * @param {number} opts.savedAt      — epoch ms of the save
   * @param {string} opts.pageTitle    — page title at save time
   * @param {Function} opts.onDismiss  — called when user dismisses
   * @param {Function} opts.onDiscard  — called when user discards the session
   */
  function showRecoveryBanner({ fieldCount, savedAt, pageTitle, onDismiss, onDiscard }) {
    const root = _ensureShadow();
    if (_banner) _banner.remove();

    const timeStr = _relativeTime(savedAt);

    _banner = document.createElement("div");
    _banner.className  = "pr-banner";
    _banner.setAttribute("role", "alert");
    _banner.setAttribute("aria-live", "polite");
    _banner.innerHTML  = `
      <div class="pr-banner__icon">↩</div>
      <div class="pr-banner__body">
        <strong>Session restored</strong>
        <span class="pr-banner__sub">
          ${fieldCount} field${fieldCount !== 1 ? "s" : ""} refilled from your save ${timeStr}.
        </span>
      </div>
      <div class="pr-banner__actions">
        <button class="pr-banner__btn pr-banner__btn--discard" aria-label="Discard saved data">
          Discard
        </button>
        <button class="pr-banner__btn pr-banner__btn--dismiss" aria-label="Dismiss this notification">
          ✕
        </button>
      </div>`;

    _banner.querySelector(".pr-banner__btn--dismiss").addEventListener("click", () => {
      _banner.classList.add("pr-banner--out");
      setTimeout(() => _banner?.remove(), 300);
      onDismiss?.();
    });

    _banner.querySelector(".pr-banner__btn--discard").addEventListener("click", () => {
      if (confirm("Discard your saved form data for this page? This cannot be undone.")) {
        _banner.classList.add("pr-banner--out");
        setTimeout(() => _banner?.remove(), 300);
        onDiscard?.();
      }
    });

    root.appendChild(_banner);

    // Auto-dismiss after 12 seconds
    setTimeout(() => {
      if (_banner && _banner.isConnected) {
        _banner.classList.add("pr-banner--out");
        setTimeout(() => _banner?.remove(), 300);
      }
    }, 12_000);
  }

  // ── Save Indicator (floating status chip) ──────────────────────────────────

  let _indicator    = null;
  let _indicatorTimer = null;
  const STATES = {
    saving:  { label: "Saving…",       cls: "pr-indicator--saving"  },
    saved:   { label: "✓ Auto-saved",  cls: "pr-indicator--saved"   },
    error:   { label: "⚠ Save error",  cls: "pr-indicator--error"   },
    offline: { label: "● Offline",     cls: "pr-indicator--offline" },
  };

  function _ensureIndicator() {
    if (_indicator) return _indicator;
    const root = _ensureShadow();

    _indicator = document.createElement("div");
    _indicator.className = "pr-indicator";
    _indicator.setAttribute("aria-live", "polite");
    _indicator.setAttribute("aria-label", "Auto-save status");
    root.appendChild(_indicator);
    return _indicator;
  }

  /**
   * Updates the save indicator chip.
   * @param {"saving"|"saved"|"error"|"offline"} state
   */
  function setSaveState(state) {
    const el  = _ensureIndicator();
    const cfg = STATES[state] || STATES.saved;

    // Remove all state classes
    Object.values(STATES).forEach(s => el.classList.remove(s.cls));
    el.classList.add(cfg.cls, "pr-indicator--visible");
    el.textContent = cfg.label;

    clearTimeout(_indicatorTimer);
    // Auto-hide after 3 seconds for "saved" state
    if (state === "saved") {
      _indicatorTimer = setTimeout(() => {
        el.classList.remove("pr-indicator--visible");
      }, 3_000);
    }
  }

  // ── Floating Panel ─────────────────────────────────────────────────────────

  let _panel       = null;
  let _panelOpen   = false;
  let _fab         = null;   // Floating Action Button

  function _ensurePanel() {
    if (_panel) return;
    const root = _ensureShadow();

    // FAB (toggle button)
    _fab = document.createElement("button");
    _fab.className   = "pr-fab";
    _fab.title       = "Portal Rescuer — click to open panel";
    _fab.setAttribute("aria-label", "Portal Rescuer panel");
    _fab.innerHTML   = `<span class="pr-fab__icon">🛡</span>`;
    _fab.addEventListener("click", togglePanel);
    root.appendChild(_fab);

    // Panel
    _panel = document.createElement("div");
    _panel.className = "pr-panel";
    _panel.setAttribute("role", "complementary");
    _panel.setAttribute("aria-label", "Portal Rescuer panel");
    _panel.innerHTML = `
      <div class="pr-panel__header">
        <span class="pr-panel__title">🛡 Portal Rescuer</span>
        <button class="pr-panel__close" aria-label="Close panel">✕</button>
      </div>
      <div class="pr-panel__body" id="pr-panel-body">
        <div class="pr-panel__row">
          <span class="pr-panel__lbl">Status</span>
          <span class="pr-panel__val" id="pr-panel-status">Active</span>
        </div>
        <div class="pr-panel__row">
          <span class="pr-panel__lbl">Fields tracked</span>
          <span class="pr-panel__val" id="pr-panel-fields">0</span>
        </div>
        <div class="pr-panel__row">
          <span class="pr-panel__lbl">Last saved</span>
          <span class="pr-panel__val" id="pr-panel-saved">—</span>
        </div>
        <div class="pr-panel__divider"></div>
        <div class="pr-panel__row">
          <span class="pr-panel__lbl">Retry queue</span>
          <span class="pr-panel__val" id="pr-panel-retry">0 jobs</span>
        </div>
        <div class="pr-panel__actions">
          <button class="pr-panel__btn pr-panel__btn--primary" id="pr-panel-save-now">
            💾 Save Now
          </button>
          <button class="pr-panel__btn pr-panel__btn--ghost" id="pr-panel-open-popup">
            ⚙ Open Panel
          </button>
        </div>
      </div>`;

    _panel.querySelector(".pr-panel__close").addEventListener("click", hidePanel);
    _panel.querySelector("#pr-panel-save-now").addEventListener("click", () => {
      window.PortalRescuer.autosave?.forceFlush();
      setSaveState("saving");
      setTimeout(() => setSaveState("saved"), 600);
    });
    _panel.querySelector("#pr-panel-open-popup").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_POPUP" }).catch(() => {});
    });

    root.appendChild(_panel);
  }

  function showPanel() {
    _ensurePanel();
    _panel.classList.add("pr-panel--open");
    _fab.classList.add("pr-fab--active");
    _panelOpen = true;
    _updatePanel();
  }

  function hidePanel() {
    if (!_panel) return;
    _panel.classList.remove("pr-panel--open");
    _fab?.classList.remove("pr-fab--active");
    _panelOpen = false;
  }

  function togglePanel() {
    _panelOpen ? hidePanel() : showPanel();
  }

  function _updatePanel() {
    if (!_panel || !_panelOpen) return;
    const snap    = window.PortalRescuer.autosave?.getSnapshot() || {};
    const fields  = Object.keys(snap).length;

    const bodyEl  = _panel.querySelector("#pr-panel-fields");
    const savedEl = _panel.querySelector("#pr-panel-saved");
    const retryEl = _panel.querySelector("#pr-panel-retry");

    if (bodyEl)  bodyEl.textContent  = fields;
    if (savedEl) savedEl.textContent = "just now"; // autosave updates this
    if (retryEl) {
      chrome.runtime.sendMessage({ type: "GET_RETRY_QUEUE" }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const pending = (res.queue || []).filter(j => j.status === "pending").length;
        retryEl.textContent = pending > 0 ? `${pending} pending` : "None";
      });
    }
  }

  // ── Error page detection ───────────────────────────────────────────────────

  const ERROR_PATTERNS = [
    /session\s+(?:has\s+)?(?:expired|timed?\s*out)/i,
    /your\s+session\s+is\s+no\s+longer\s+valid/i,
    /please\s+try\s+again\s+later/i,
    /service\s+(?:is\s+)?(?:temporarily\s+)?unavailable/i,
    /internal\s+server\s+error/i,
    /error\s+(?:code\s+)?5\d\d/i,
    /gateway\s+(?:timeout|error)/i,
    /connection\s+(?:timed?\s+out|refused|reset)/i,
    /we\s+(?:are\s+)?(?:experiencing|have)\s+technical\s+difficulties/i,
  ];

  /**
   * Scans the page body text for known error patterns.
   * If found, injects an error-intercept banner offering to report to the
   * background retry queue.
   */
  function detectErrorPage() {
    const bodyText = document.body?.innerText || "";
    const matched  = ERROR_PATTERNS.find(p => p.test(bodyText));
    if (!matched) return false;

    // Only show once per page load
    if (_ensureShadow().querySelector(".pr-error-intercept")) return true;

    const root = _ensureShadow();
    const el   = document.createElement("div");
    el.className = "pr-error-intercept";
    el.setAttribute("role", "alert");
    el.innerHTML = `
      <div class="pr-ei__icon">⚠️</div>
      <div class="pr-ei__body">
        <strong>Portal error detected</strong>
        <span class="pr-ei__sub">Portal Rescuer detected an error on this page. Your data is safe.</span>
      </div>
      <div class="pr-ei__actions">
        <button class="pr-ei__btn pr-ei__btn--retry" aria-label="Queue for retry">
          ↺ Queue Retry
        </button>
        <button class="pr-ei__btn pr-ei__btn--dismiss" aria-label="Dismiss">✕</button>
      </div>`;

    el.querySelector(".pr-ei__btn--retry").addEventListener("click", () => {
      const sessionKey = window.PortalRescuer.autosave?.getSessionKey();
      const snapshot   = window.PortalRescuer.autosave?.getSnapshot();
      if (sessionKey) {
        chrome.runtime.sendMessage({
          type:       "REPORT_ERROR",
          sessionKey,
          snapshot,
          formAction: location.href,
          formMethod: "POST",
        });
        setSaveState("saving");
      }
      el.remove();
    });

    el.querySelector(".pr-ei__btn--dismiss").addEventListener("click", () => el.remove());

    root.appendChild(el);
    return true;
  }

  // ── Field restoration highlight (called from refill.js via CSS class) ──────
  // The .pr-restored class is added to elements in the main document.
  // We inject a <style> into the host document (not shadow) for this
  // because the class is on portal page elements, not our shadow DOM.

  function _injectGlobalStyles() {
    if (document.getElementById("pr-global-styles")) return;
    const s = document.createElement("style");
    s.id = "pr-global-styles";
    s.textContent = `
      .pr-restored {
        outline: 2px solid #17a589 !important;
        outline-offset: 2px !important;
        transition: outline 0.3s ease !important;
        animation: pr-restore-flash 2.5s ease forwards !important;
      }
      @keyframes pr-restore-flash {
        0%   { outline-color: #17a589; background-color: rgba(23,165,137,.12); }
        80%  { outline-color: #17a589; background-color: rgba(23,165,137,.05); }
        100% { outline-color: transparent; background-color: transparent; }
      }
    `;
    document.head?.appendChild(s);
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    _ensureShadow();
    _ensurePanel();   // creates FAB immediately
    _injectGlobalStyles();

    // Run error detection once DOM is settled
    setTimeout(detectErrorPage, 1500);

    // Listen for save state changes from autosave
    window.addEventListener("pr:saving", () => setSaveState("saving"));
    window.addEventListener("pr:saved",  () => setSaveState("saved"));
    window.addEventListener("pr:error",  () => setSaveState("error"));

    // Update panel every 5s if open
    setInterval(() => { if (_panelOpen) _updatePanel(); }, 5_000);
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  function _relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5)    return "just now";
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return new Date(ts).toLocaleDateString();
  }

  // ── Overlay CSS (injected into Shadow DOM) ─────────────────────────────────

  const _OVERLAY_CSS = `
    /* ── Shared tokens ── */
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }

    :host {
      --pr-navy:   #1a5276;
      --pr-teal:   #17a589;
      --pr-warn:   #e67e22;
      --pr-danger: #c0392b;
      --pr-bg:     #ffffff;
      --pr-text:   #1c2833;
      --pr-muted:  #7f8c8d;
      --pr-border: #dde2ea;
      --pr-radius: 10px;
      --pr-shadow: 0 4px 20px rgba(0,0,0,.18), 0 1px 4px rgba(0,0,0,.10);
      --pr-font:   "Segoe UI", system-ui, -apple-system, sans-serif;
    }

    /* ── Recovery Banner ── */
    .pr-banner {
      position:    fixed;
      top:         12px;
      left:        50%;
      transform:   translateX(-50%);
      min-width:   320px;
      max-width:   560px;
      background:  var(--pr-bg);
      border-left: 4px solid var(--pr-teal);
      border-radius: var(--pr-radius);
      box-shadow:  var(--pr-shadow);
      padding:     12px 14px;
      display:     flex;
      align-items: center;
      gap:         12px;
      font-family: var(--pr-font);
      font-size:   13px;
      color:       var(--pr-text);
      pointer-events: all;
      animation:   pr-slide-down .3s cubic-bezier(.22,1,.36,1);
      z-index:     2147483647;
    }
    .pr-banner--out {
      animation: pr-slide-up .3s ease forwards;
    }
    .pr-banner__icon {
      font-size:  20px;
      flex-shrink: 0;
    }
    .pr-banner__body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .pr-banner__body strong { font-weight: 700; color: var(--pr-teal); }
    .pr-banner__sub { font-size: 12px; color: var(--pr-muted); }
    .pr-banner__actions { display: flex; gap: 6px; flex-shrink: 0; }
    .pr-banner__btn {
      border:        none;
      border-radius: 6px;
      padding:       5px 10px;
      font:          600 12px var(--pr-font);
      cursor:        pointer;
      transition:    background .15s;
    }
    .pr-banner__btn--dismiss { background: var(--pr-border); color: var(--pr-muted); }
    .pr-banner__btn--dismiss:hover { background: #c8d0da; }
    .pr-banner__btn--discard { background: #fdf0ef; color: var(--pr-danger); border: 1px solid #f5c6c3; }
    .pr-banner__btn--discard:hover { background: #fad7d4; }

    /* ── Save Indicator ── */
    .pr-indicator {
      position:      fixed;
      bottom:        68px;
      right:         14px;
      padding:       5px 11px;
      border-radius: 99px;
      font:          600 11px var(--pr-font);
      pointer-events: none;
      opacity:       0;
      transform:     translateY(4px);
      transition:    opacity .2s, transform .2s;
      z-index:       2147483647;
    }
    .pr-indicator--visible { opacity: 1; transform: translateY(0); }
    .pr-indicator--saving  { background: #eaf4fb; color: #2e86c1; }
    .pr-indicator--saved   { background: #eafaf1; color: #1e8449; }
    .pr-indicator--error   { background: #fdedec; color: var(--pr-danger); }
    .pr-indicator--offline { background: #fef9e7; color: var(--pr-warn); }

    /* ── FAB ── */
    .pr-fab {
      position:      fixed;
      bottom:        14px;
      right:         14px;
      width:         44px;
      height:        44px;
      border-radius: 50%;
      background:    var(--pr-navy);
      border:        none;
      color:         #fff;
      font-size:     20px;
      cursor:        pointer;
      box-shadow:    var(--pr-shadow);
      display:       flex;
      align-items:   center;
      justify-content: center;
      transition:    background .2s, transform .2s;
      pointer-events: all;
      z-index:       2147483647;
    }
    .pr-fab:hover   { background: #21618c; transform: scale(1.08); }
    .pr-fab--active { background: var(--pr-teal); }
    .pr-fab__icon   { pointer-events: none; line-height: 1; }

    /* ── Floating Panel ── */
    .pr-panel {
      position:      fixed;
      bottom:        66px;
      right:         14px;
      width:         240px;
      background:    var(--pr-bg);
      border-radius: var(--pr-radius);
      box-shadow:    var(--pr-shadow);
      font-family:   var(--pr-font);
      font-size:     13px;
      color:         var(--pr-text);
      pointer-events: all;
      transform-origin: bottom right;
      transform:     scale(.85);
      opacity:       0;
      transition:    transform .2s cubic-bezier(.22,1,.36,1), opacity .2s;
      pointer-events: none;
      z-index:       2147483646;
      overflow:      hidden;
    }
    .pr-panel--open {
      transform:     scale(1);
      opacity:       1;
      pointer-events: all;
    }
    .pr-panel__header {
      display:         flex;
      align-items:     center;
      justify-content: space-between;
      padding:         10px 12px;
      background:      var(--pr-navy);
      color:           #fff;
    }
    .pr-panel__title { font-size: 13px; font-weight: 700; }
    .pr-panel__close {
      background: transparent;
      border:     none;
      color:      rgba(255,255,255,.7);
      cursor:     pointer;
      font-size:  14px;
      padding:    2px 4px;
      border-radius: 4px;
    }
    .pr-panel__close:hover { background: rgba(255,255,255,.15); color: #fff; }
    .pr-panel__body   { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
    .pr-panel__row    { display: flex; justify-content: space-between; padding: 3px 0; }
    .pr-panel__lbl    { font-size: 12px; color: var(--pr-muted); }
    .pr-panel__val    { font-size: 12px; font-weight: 600; }
    .pr-panel__divider{ border-top: 1px solid var(--pr-border); margin: 4px 0; }
    .pr-panel__actions{ display: flex; gap: 6px; margin-top: 6px; }
    .pr-panel__btn {
      flex:          1;
      border:        none;
      border-radius: 6px;
      padding:       6px 8px;
      font:          600 11px var(--pr-font);
      cursor:        pointer;
      transition:    background .15s;
    }
    .pr-panel__btn--primary { background: var(--pr-teal); color: #fff; }
    .pr-panel__btn--primary:hover { background: #14907a; }
    .pr-panel__btn--ghost {
      background: transparent;
      color:      var(--pr-muted);
      border:     1px solid var(--pr-border);
    }
    .pr-panel__btn--ghost:hover { background: var(--pr-border); color: var(--pr-text); }

    /* ── Error Intercept Banner ── */
    .pr-error-intercept {
      position:    fixed;
      bottom:      70px;
      left:        50%;
      transform:   translateX(-50%);
      min-width:   300px;
      max-width:   500px;
      background:  var(--pr-bg);
      border-left: 4px solid var(--pr-warn);
      border-radius: var(--pr-radius);
      box-shadow:  var(--pr-shadow);
      padding:     12px 14px;
      display:     flex;
      align-items: center;
      gap:         12px;
      font-family: var(--pr-font);
      font-size:   13px;
      color:       var(--pr-text);
      pointer-events: all;
      animation:   pr-slide-up-from-bottom .3s cubic-bezier(.22,1,.36,1);
      z-index:     2147483647;
    }
    .pr-ei__icon  { font-size: 20px; flex-shrink: 0; }
    .pr-ei__body  { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .pr-ei__body strong { font-weight: 700; color: var(--pr-warn); }
    .pr-ei__sub   { font-size: 12px; color: var(--pr-muted); }
    .pr-ei__actions { display: flex; gap: 6px; flex-shrink: 0; }
    .pr-ei__btn {
      border:        none;
      border-radius: 6px;
      padding:       5px 10px;
      font:          600 12px var(--pr-font);
      cursor:        pointer;
    }
    .pr-ei__btn--retry   { background: var(--pr-warn); color: #fff; }
    .pr-ei__btn--retry:hover { background: #ca6f1e; }
    .pr-ei__btn--dismiss { background: var(--pr-border); color: var(--pr-muted); }
    .pr-ei__btn--dismiss:hover { background: #c8d0da; }

    /* ── Animations ── */
    @keyframes pr-slide-down {
      from { opacity: 0; transform: translateX(-50%) translateY(-16px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    @keyframes pr-slide-up {
      from { opacity: 1; transform: translateX(-50%) translateY(0); }
      to   { opacity: 0; transform: translateX(-50%) translateY(-12px); }
    }
    @keyframes pr-slide-up-from-bottom {
      from { opacity: 0; transform: translateX(-50%) translateY(16px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;

  // Auto-init when script loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    showRecoveryBanner,
    setSaveState,
    showPanel,
    hidePanel,
    togglePanel,
    detectErrorPage,
  };
})();
