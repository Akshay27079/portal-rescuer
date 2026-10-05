/**
 * injector.js — Portal Rescuer overlay layer.
 * Injects FAB, floating panel, save indicator, recovery banner,
 * and error intercept into an isolated Shadow DOM.
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.overlay = (() => {

  // ── Shadow DOM ──────────────────────────────────────────────────────────────
  let _root = null;

  function _shadow() {
    if (_root) return _root;

    const host = document.createElement("div");
    host.id = "pr-host";

    // Full-viewport transparent overlay — host itself ignores clicks,
    // only FAB/panel/banners (with pointer-events:all) receive them.
    Object.assign(host.style, {
      position:        "fixed",
      inset:           "0",
      width:           "100%",
      height:          "100%",
      zIndex:          "2147483647",
      pointerEvents:   "none",
      background:      "transparent",
      overflow:        "visible",
    });

    _root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    _root.appendChild(style);

    document.documentElement.appendChild(host);
    return _root;
  }

  // ── FAB + Panel ─────────────────────────────────────────────────────────────
  let _fab       = null;
  let _panel     = null;
  let _open      = false;
  let _panelTimer= null;

  function _buildFABAndPanel() {
    if (_fab) return;
    const root = _shadow();

    // FAB
    _fab = document.createElement("button");
    _fab.className = "fab";
    _fab.title     = "Portal Rescuer";
    _fab.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2L3 6v6c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V6L12 2z" fill="white"/></svg>`;
    _fab.addEventListener("click", togglePanel);
    root.appendChild(_fab);

    // Panel
    _panel = document.createElement("div");
    _panel.className = "panel";
    _panel.innerHTML = `
      <div class="panel-head">
        <span>Portal Rescuer</span>
        <button class="close-btn" id="pr-close">&#x2715;</button>
      </div>
      <div class="panel-body">
        <div class="row"><span class="lbl">Status</span>     <span class="val" id="pr-status">Watching</span></div>
        <div class="row"><span class="lbl">Fields saved</span><span class="val" id="pr-fields">0</span></div>
        <div class="row"><span class="lbl">Last saved</span> <span class="val" id="pr-saved">—</span></div>
        <div class="row"><span class="lbl">Retry queue</span><span class="val" id="pr-retry">None</span></div>
        <hr class="divider"/>
        <div class="actions">
          <button class="btn-primary" id="pr-save-now">💾 Save Now</button>
          <button class="btn-ghost"   id="pr-discard">🗑 Discard</button>
        </div>
      </div>`;

    root.appendChild(_panel);

    // Bind panel buttons
    _panel.querySelector("#pr-close").onclick    = hidePanel;
    _panel.querySelector("#pr-save-now").onclick = _onSaveNow;
    _panel.querySelector("#pr-discard").onclick  = _onDiscard;
  }

  function showPanel() {
    _buildFABAndPanel();
    _open = true;
    _panel.classList.add("panel--open");
    _fab.classList.add("fab--active");
    _refreshPanel();
    // Keep refreshing while open
    _panelTimer = setInterval(_refreshPanel, 4000);
  }

  function hidePanel() {
    if (!_panel) return;
    _open = false;
    _panel.classList.remove("panel--open");
    _fab?.classList.remove("fab--active");
    clearInterval(_panelTimer);
  }

  function togglePanel() {
    _open ? hidePanel() : showPanel();
  }

  function _refreshPanel() {
    if (!_panel) return;

    const snap   = window.PortalRescuer.autosave?.getSnapshot() || {};
    const fields = Object.keys(snap).length;
    const key    = window.PortalRescuer.autosave?.getSessionKey();

    _set("pr-status", fields > 0 ? "✓ Protecting" : "Watching");
    _set("pr-fields", String(fields));

    // Real last-saved time from storage
    if (key) {
      chrome.storage.local.get(`pr_snapshot_${key}`, (res) => {
        const ts = res?.[`pr_snapshot_${key}`]?.savedAt;
        _set("pr-saved", ts ? _ago(ts) : "Not yet");
      });
    }

    // Retry queue count
    try {
      chrome.runtime.sendMessage({ type: "GET_RETRY_QUEUE" }, (res) => {
        if (chrome.runtime.lastError) return;
        const pending = (res?.queue || []).filter(j => j.status === "pending").length;
        _set("pr-retry", pending > 0 ? `${pending} pending` : "None");
      });
    } catch (_) {}
  }

  function _onSaveNow() {
    window.PortalRescuer.autosave?.forceFlush();
    setSaveState("saving");
    setTimeout(() => setSaveState("saved"), 800);
  }

  function _onDiscard() {
    const key = window.PortalRescuer.autosave?.getSessionKey();
    if (!key) return;
    if (!confirm("Delete saved data for this page?")) return;
    window.PortalRescuer.refill?.discardSession(key);
    _set("pr-fields", "0");
    _set("pr-saved", "—");
    _set("pr-status", "Watching");
  }

  function _set(id, text) {
    const el = _panel?.querySelector(`#${id}`);
    if (el) el.textContent = text;
  }

  // ── Save indicator chip ─────────────────────────────────────────────────────
  let _chip      = null;
  let _chipTimer = null;

  function setSaveState(state) {
    if (!_chip) {
      _chip = document.createElement("div");
      _chip.className = "chip";
      _shadow().appendChild(_chip);
    }
    _chip.className = `chip chip--${state} chip--visible`;
    _chip.textContent = {
      saving:  "⏳ Saving…",
      saved:   "✓ Saved",
      error:   "⚠ Save error",
      offline: "● Offline",
    }[state] || "✓ Saved";

    clearTimeout(_chipTimer);
    if (state === "saved") {
      _chipTimer = setTimeout(() => _chip.classList.remove("chip--visible"), 3000);
    }
  }

  // ── Recovery banner ─────────────────────────────────────────────────────────
  let _banner = null;

  function showRecoveryBanner({ fieldCount, savedAt, onDismiss, onDiscard }) {
    const root = _shadow();
    _banner?.remove();

    _banner = document.createElement("div");
    _banner.className = "banner";
    _banner.innerHTML = `
      <span class="banner-icon">↩</span>
      <div class="banner-body">
        <strong>Session restored</strong>
        <span class="banner-sub">${fieldCount} field${fieldCount !== 1 ? "s" : ""} refilled · saved ${_ago(savedAt)}</span>
      </div>
      <div class="banner-btns">
        <button class="banner-btn banner-discard">Discard</button>
        <button class="banner-btn banner-dismiss">✕</button>
      </div>`;

    _banner.querySelector(".banner-dismiss").onclick = () => {
      _banner.classList.add("banner--out");
      setTimeout(() => _banner?.remove(), 300);
      onDismiss?.();
    };
    _banner.querySelector(".banner-discard").onclick = () => {
      if (confirm("Discard saved data for this page?")) {
        _banner.classList.add("banner--out");
        setTimeout(() => _banner?.remove(), 300);
        onDiscard?.();
      }
    };

    root.appendChild(_banner);
    setTimeout(() => {
      if (_banner?.isConnected) {
        _banner.classList.add("banner--out");
        setTimeout(() => _banner?.remove(), 300);
      }
    }, 12000);
  }

  // ── Error page detection ────────────────────────────────────────────────────
  const ERROR_RE = [
    /session.{0,10}(expired|timed?\s*out)/i,
    /please\s+try\s+again\s+later/i,
    /service\s+(temporarily\s+)?unavailable/i,
    /internal\s+server\s+error/i,
    /gateway\s+(timeout|error)/i,
    /error\s+5\d\d/i,
  ];

  function detectErrorPage() {
    const text = document.body?.innerText || "";
    if (!ERROR_RE.some(r => r.test(text))) return false;
    if (_shadow().querySelector(".err-banner")) return true;

    const root = _shadow();
    const el   = document.createElement("div");
    el.className = "err-banner";
    el.innerHTML = `
      <span>⚠️</span>
      <div class="err-body">
        <strong>Portal error detected</strong>
        <span>Your data is safe. Queue a retry?</span>
      </div>
      <div class="err-btns">
        <button class="err-retry">↺ Retry</button>
        <button class="err-close">✕</button>
      </div>`;

    el.querySelector(".err-retry").onclick = () => {
      try {
        chrome.runtime.sendMessage({
          type:       "REPORT_ERROR",
          sessionKey: window.PortalRescuer.autosave?.getSessionKey(),
          snapshot:   window.PortalRescuer.autosave?.getSnapshot(),
          formAction: location.href,
          formMethod: "POST",
        });
      } catch (_) {}
      setSaveState("saving");
      el.remove();
    };
    el.querySelector(".err-close").onclick = () => el.remove();
    root.appendChild(el);
    return true;
  }

  // ── Global restore highlight ────────────────────────────────────────────────
  function _injectGlobalCSS() {
    if (document.getElementById("pr-global")) return;
    const s = document.createElement("style");
    s.id = "pr-global";
    s.textContent = `
      .pr-restored {
        outline: 2px solid #17a589 !important;
        outline-offset: 2px !important;
        animation: pr-flash 2.5s ease forwards !important;
      }
      @keyframes pr-flash {
        0%   { outline-color:#17a589; background:rgba(23,165,137,.12); }
        100% { outline-color:transparent; background:transparent; }
      }`;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Listen for save events from autosave.js ─────────────────────────────────
  window.addEventListener("pr:saving", () => setSaveState("saving"));
  window.addEventListener("pr:saved",  () => setSaveState("saved"));
  window.addEventListener("pr:error",  () => setSaveState("error"));

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    _buildFABAndPanel();
    _injectGlobalCSS();
    setTimeout(detectErrorPage, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function _ago(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5)    return "just now";
    if (s < 60)   return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    return new Date(ts).toLocaleTimeString();
  }

  // ── CSS ─────────────────────────────────────────────────────────────────────
  const CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :host {
      --navy:   #1a5276;
      --teal:   #17a589;
      --warn:   #e67e22;
      --danger: #c0392b;
      --bg:     #ffffff;
      --text:   #1c2833;
      --muted:  #7f8c8d;
      --border: #dde2ea;
      --r:      10px;
      --sh:     0 4px 24px rgba(0,0,0,.18), 0 1px 4px rgba(0,0,0,.08);
      --font:   "Segoe UI", system-ui, sans-serif;
    }

    /* FAB */
    .fab {
      position:       fixed;
      bottom:         18px;
      right:          18px;
      width:          48px;
      height:         48px;
      border-radius:  50%;
      background:     var(--navy);
      border:         none;
      color:          #fff;
      font-size:      22px;
      cursor:         pointer;
      box-shadow:     var(--sh);
      display:        flex;
      align-items:    center;
      justify-content:center;
      transition:     background .2s, transform .15s;
      pointer-events: all;
      z-index:        1;
      line-height:    1;
    }
    .fab:hover      { background: #21618c; transform: scale(1.1); }
    .fab--active    { background: var(--teal); }

    /* Panel */
    .panel {
      position:       fixed;
      bottom:         74px;
      right:          18px;
      width:          260px;
      background:     var(--bg);
      border-radius:  var(--r);
      box-shadow:     var(--sh);
      font-family:    var(--font);
      font-size:      13px;
      color:          var(--text);
      transform-origin: bottom right;
      transform:      scale(0.85);
      opacity:        0;
      pointer-events: none;
      transition:     transform .2s cubic-bezier(.22,1,.36,1), opacity .2s;
      z-index:        1;
      overflow:       hidden;
    }
    .panel--open {
      transform:      scale(1);
      opacity:        1;
      pointer-events: all;
    }
    .panel-head {
      display:         flex;
      align-items:     center;
      justify-content: space-between;
      padding:         10px 14px;
      background:      var(--navy);
      color:           #fff;
      font-weight:     700;
      font-size:       13px;
    }
    .close-btn {
      background: transparent;
      border:     none;
      color:      rgba(255,255,255,.7);
      cursor:     pointer;
      font-size:  15px;
      padding:    2px 5px;
      border-radius: 4px;
    }
    .close-btn:hover { background: rgba(255,255,255,.15); color: #fff; }
    .panel-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
    .row   { display: flex; justify-content: space-between; align-items: center; }
    .lbl   { font-size: 12px; color: var(--muted); }
    .val   { font-size: 12px; font-weight: 600; }
    .divider { border: none; border-top: 1px solid var(--border); margin: 4px 0; }
    .actions { display: flex; gap: 8px; }
    .btn-primary {
      flex: 1; border: none; border-radius: 7px; padding: 7px 0;
      background: var(--teal); color: #fff; font: 600 12px var(--font);
      cursor: pointer; transition: background .15s;
    }
    .btn-primary:hover { background: #14907a; }
    .btn-ghost {
      flex: 1; border: 1px solid var(--border); border-radius: 7px; padding: 7px 0;
      background: transparent; color: var(--muted); font: 600 12px var(--font);
      cursor: pointer; transition: background .15s;
    }
    .btn-ghost:hover { background: var(--border); }

    /* Save chip */
    .chip {
      position:       fixed;
      bottom:         74px;
      right:          18px;
      padding:        5px 12px;
      border-radius:  99px;
      font:           600 11px var(--font);
      pointer-events: none;
      opacity:        0;
      transform:      translateY(4px);
      transition:     opacity .2s, transform .2s;
      z-index:        1;
    }
    .chip--visible       { opacity: 1; transform: translateY(0); }
    .chip--saving        { background: #eaf4fb; color: #2e86c1; }
    .chip--saved         { background: #eafaf1; color: #1e8449; }
    .chip--error         { background: #fdedec; color: var(--danger); }
    .chip--offline       { background: #fef9e7; color: var(--warn); }

    /* Recovery banner */
    .banner {
      position:       fixed;
      top:            14px;
      left:           50%;
      transform:      translateX(-50%);
      min-width:      300px;
      max-width:      540px;
      background:     var(--bg);
      border-left:    4px solid var(--teal);
      border-radius:  var(--r);
      box-shadow:     var(--sh);
      padding:        12px 14px;
      display:        flex;
      align-items:    center;
      gap:            12px;
      font-family:    var(--font);
      font-size:      13px;
      color:          var(--text);
      pointer-events: all;
      z-index:        1;
      animation:      slideDown .3s cubic-bezier(.22,1,.36,1);
    }
    .banner--out { animation: slideUp .3s ease forwards; }
    .banner-icon { font-size: 20px; flex-shrink: 0; }
    .banner-body { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .banner-body strong { font-weight: 700; color: var(--teal); }
    .banner-sub  { font-size: 11px; color: var(--muted); }
    .banner-btns { display: flex; gap: 6px; flex-shrink: 0; }
    .banner-btn  {
      border: none; border-radius: 6px; padding: 5px 10px;
      font: 600 11px var(--font); cursor: pointer;
    }
    .banner-dismiss { background: var(--border); color: var(--muted); }
    .banner-discard { background: #fdf0ef; color: var(--danger); border: 1px solid #f5c6c3; }

    /* Error banner */
    .err-banner {
      position:       fixed;
      bottom:         80px;
      left:           50%;
      transform:      translateX(-50%);
      min-width:      300px;
      background:     var(--bg);
      border-left:    4px solid var(--warn);
      border-radius:  var(--r);
      box-shadow:     var(--sh);
      padding:        12px 14px;
      display:        flex;
      align-items:    center;
      gap:            12px;
      font-family:    var(--font);
      font-size:      13px;
      color:          var(--text);
      pointer-events: all;
      z-index:        1;
      animation:      slideUp2 .3s cubic-bezier(.22,1,.36,1);
    }
    .err-body  { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .err-body strong { font-weight: 700; color: var(--warn); }
    .err-body span   { font-size: 11px; color: var(--muted); }
    .err-btns  { display: flex; gap: 6px; flex-shrink: 0; }
    .err-retry { background: var(--warn); color: #fff; border: none; border-radius: 6px; padding: 5px 10px; font: 600 11px var(--font); cursor: pointer; }
    .err-close { background: var(--border); color: var(--muted); border: none; border-radius: 6px; padding: 5px 10px; font: 600 11px var(--font); cursor: pointer; }

    /* Animations */
    @keyframes slideDown {
      from { opacity:0; transform: translateX(-50%) translateY(-14px); }
      to   { opacity:1; transform: translateX(-50%) translateY(0); }
    }
    @keyframes slideUp {
      from { opacity:1; transform: translateX(-50%) translateY(0); }
      to   { opacity:0; transform: translateX(-50%) translateY(-10px); }
    }
    @keyframes slideUp2 {
      from { opacity:0; transform: translateX(-50%) translateY(14px); }
      to   { opacity:1; transform: translateX(-50%) translateY(0); }
    }
  `;

  return { init, showPanel, hidePanel, togglePanel, setSaveState, showRecoveryBanner, detectErrorPage };
})();
