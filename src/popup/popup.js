/**
 * popup.js — Portal Rescuer popup controller.
 */

"use strict";

// ── DOM refs ──────────────────────────────────────────────────────────────────

const el = id => document.getElementById(id);

const $pageTitle    = el("currentPageTitle");
const $fieldCount   = el("currentFieldCount");
const $lastSaved    = el("currentLastSaved");
const $pageCard     = el("currentPageCard");
const $noPage       = el("noCurrentPage");
const $btnRefill    = el("btnForceRefill");
const $btnDiscard   = el("btnDiscardSession");
const $retryCount   = el("retryCount");
const $retryList    = el("retryJobList");
const $noRetry      = el("noRetryJobs");
const $btnClear     = el("btnClearSucceeded");
const $sessionCount = el("sessionCount");
const $sessionList  = el("sessionList");
const $noSessions   = el("noSessions");
const $toasts       = el("toastContainer");
const $badge        = el("statusBadge");

// ── State ─────────────────────────────────────────────────────────────────────

let _tab      = null;
let _status   = null;
let _queue    = [];
let _sessions = [];
let _timer    = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  _tab = await _activeTab();
  await _refresh();
  _timer = setInterval(_refresh, 3000);
  _bind();
});

window.addEventListener("unload", () => clearInterval(_timer));

// ── Refresh ───────────────────────────────────────────────────────────────────

async function _refresh() {
  await Promise.all([_refreshPage(), _refreshQueue(), _refreshSessions()]);
}

async function _refreshPage() {
  if (!_tab?.id) { _hidePage(); return; }
  try {
    const s = await _tabMsg(_tab.id, { type: "GET_STATUS" });
    if (!s?.sessionKey) { _hidePage(); return; }
    _status = s;

    // Load saved metadata from chrome.storage
    const key  = `pr_snapshot_${s.sessionKey}`;
    const data = await _store(key);
    const snap = data?.[key];

    $pageTitle.textContent  = _trunc(s.pageTitle || s.pageUrl, 38);
    $fieldCount.textContent = Object.keys(s.snapshot || {}).length;
    $lastSaved.textContent  = snap?.savedAt ? _ago(snap.savedAt) : "Not yet";

    $pageCard.hidden = false;
    $noPage.hidden   = true;
    _badge("active");
  } catch (_) {
    _hidePage();
  }
}

function _hidePage() {
  $pageCard.hidden = true;
  $noPage.hidden   = false;
  _badge("inactive");
}

async function _refreshQueue() {
  try {
    const r = await _bgMsg({ type: "GET_RETRY_QUEUE" });
    _queue = r?.queue || [];
  } catch (_) { _queue = []; }
  _renderQueue();
}

async function _refreshSessions() {
  try {
    // chrome.storage.local.get(null) fetches everything — works in all versions
    const all = await new Promise(r => chrome.storage.local.get(null, r));
    _sessions = Object.entries(all || {})
      .filter(([k]) => k.startsWith("pr_snapshot_"))
      .map(([, v]) => v)
      .filter(v => v && v.snapshot)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch (_) { _sessions = []; }
  _renderSessions();
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderQueue() {
  const visible = _queue.filter(j => j.status !== "cancelled");
  $retryCount.textContent = visible.length;

  if (!visible.length) {
    $retryList.innerHTML = "";
    $noRetry.hidden = false;
    return;
  }
  $noRetry.hidden = true;
  $retryList.innerHTML = visible.map(j => {
    const next = j.nextRetryAt > Date.now()
      ? `Next in ${Math.ceil((j.nextRetryAt - Date.now()) / 1000)}s`
      : "Soon…";
    return `
      <li class="pr-job" data-id="${_e(j.id)}">
        <div class="pr-job__top">
          <span class="pr-job__url" title="${_e(j.formAction || j.sessionKey)}">${_e(_trunc(j.formAction || j.sessionKey, 36))}</span>
          <span class="pr-job__status pr-job__status--${j.status}">${j.status}</span>
        </div>
        <div class="pr-job__meta">Attempt ${j.attempts}/8${j.status === "pending" ? " · " + next : ""}${j.lastError ? " · " + _e(j.lastError) : ""}</div>
        <div class="pr-job__actions">
          ${j.status === "pending"  ? `<button class="pr-btn pr-btn--primary pr-btn--sm" data-action="retry" data-id="${_e(j.id)}">↺ Now</button>` : ""}
          ${["pending","retrying"].includes(j.status) ? `<button class="pr-btn pr-btn--danger pr-btn--sm" data-action="cancel" data-id="${_e(j.id)}">✕</button>` : ""}
        </div>
      </li>`;
  }).join("");
}

function _renderSessions() {
  $sessionCount.textContent = _sessions.length;
  if (!_sessions.length) {
    $sessionList.innerHTML = "";
    $noSessions.hidden = false;
    return;
  }
  $noSessions.hidden = true;
  $sessionList.innerHTML = _sessions.map(s => {
    const fc = Object.keys(s.snapshot || {}).length;
    return `
      <li class="pr-session-item">
        <div class="pr-session-item__info">
          <span class="pr-session-item__title" title="${_e(s.pageUrl || "")}">${_e(s.pageTitle || _trunc(s.pageUrl || "Unknown", 36))}</span>
          <span class="pr-session-item__meta">${fc} field${fc !== 1 ? "s" : ""} · ${_ago(s.savedAt)}</span>
        </div>
        <div class="pr-session-item__actions">
          <button class="pr-btn pr-btn--ghost pr-btn--sm" data-action="open" data-url="${_e(s.pageUrl || "")}" title="Open page">↗</button>
          <button class="pr-btn pr-btn--danger pr-btn--sm" data-action="delete" data-key="${_e(s.pageUrl || String(s.savedAt))}" title="Delete">🗑</button>
        </div>
      </li>`;
  }).join("");
}

// ── Bindings ──────────────────────────────────────────────────────────────────

function _bind() {
  $btnRefill.addEventListener("click", async () => {
    if (!_tab?.id || !_status) return;
    $btnRefill.disabled = true;
    try {
      const key  = `pr_snapshot_${_status.sessionKey}`;
      const data = await _store(key);
      const snap = data?.[key];
      if (!snap?.snapshot) { _toast("No saved snapshot found.", "warning"); return; }
      await _tabMsg(_tab.id, { type: "FORCE_REFILL", snapshot: snap.snapshot });
      _toast("Fields restored!", "success");
    } catch (e) {
      _toast("Error: " + e.message, "error");
    } finally {
      $btnRefill.disabled = false;
    }
  });

  $btnDiscard.addEventListener("click", async () => {
    if (!_status) return;
    if (!confirm("Delete all saved data for this page?")) return;
    try {
      await _tabMsg(_tab.id, { type: "DISCARD_SESSION", sessionKey: _status.sessionKey });
      _toast("Session deleted.", "success");
      await _refresh();
    } catch (e) { _toast("Error: " + e.message, "error"); }
  });

  $btnClear.addEventListener("click", async () => {
    await _bgMsg({ type: "CLEAR_SUCCEEDED" });
    await _refreshQueue();
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, id, url, key } = btn.dataset;

    if (action === "retry")  { await _bgMsg({ type: "RETRY_NOW",  jobId: id }); _toast("Retry triggered.", "success"); await _refreshQueue(); }
    if (action === "cancel") { await _bgMsg({ type: "CANCEL_JOB", jobId: id }); _toast("Cancelled.",      "warning"); await _refreshQueue(); }
    if (action === "open"  && url) chrome.tabs.create({ url });
    if (action === "delete") {
      if (!confirm("Delete saved data for this session?")) return;
      // Find the session and remove its storage key
      const sess = _sessions.find(s => (s.pageUrl || String(s.savedAt)) === key);
      if (sess) {
        const sKey = `pr_snapshot_${_pageKey(sess.pageUrl)}`;
        await new Promise(r => chrome.storage.local.remove(sKey, r));
        _toast("Deleted.", "success");
        await _refreshSessions();
      }
    }
  });

  el("btnOpenOptions")?.addEventListener("click", () => chrome.runtime.openOptionsPage?.());

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "QUEUE_UPDATED") { _queue = msg.queue || []; _renderQueue(); }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _activeTab() {
  return new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, t => r(t[0] || null)));
}

function _tabMsg(tabId, msg) {
  return new Promise((res, rej) => {
    chrome.tabs.sendMessage(tabId, msg, r => {
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r);
    });
  });
}

function _bgMsg(msg) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(msg, r => {
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r);
    });
  });
}

function _store(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}

function _badge(state) {
  const b = $badge?.querySelector(".pr-badge");
  if (!b) return;
  if (state === "active") {
    b.className = "pr-badge pr-badge--active";
    b.textContent = "Active";
  } else {
    b.className = "pr-badge pr-badge--inactive";
    b.textContent = "Inactive";
  }
}

function _ago(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5)    return "just now";
  if (d < 60)   return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function _trunc(s, n = 40) {
  if (!s) return "—";
  try {
    const u = new URL(s);
    s = u.hostname + u.pathname;
  } catch (_) {}
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function _pageKey(url) {
  try {
    const u = new URL(url);
    ["csrf","token","nonce","sid","_","timestamp","t"].forEach(p => u.searchParams.delete(p));
    return u.origin + u.pathname + u.search;
  } catch (_) { return url; }
}

function _e(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function _toast(msg, type = "info") {
  const d = document.createElement("div");
  d.className   = `pr-toast pr-toast--${type}`;
  d.textContent = msg;
  $toasts.appendChild(d);
  setTimeout(() => d.remove(), 3000);
}
