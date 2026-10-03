/**
 * popup.js — Portal Rescuer popup controller.
 *
 * Renders:
 *  1. Current-page status (fields tracked, last saved, restore / discard)
 *  2. Retry queue (live status, manual retry, cancel per job)
 *  3. All saved sessions (browse, restore to tab, delete)
 *
 * Communicates with:
 *  - Active tab's content script  (chrome.tabs.sendMessage)
 *  - Background service worker    (chrome.runtime.sendMessage)
 *  - chrome.storage.local         (direct read for sessions)
 */

"use strict";

// ── DOM refs ─────────────────────────────────────────────────────────────────

const statusBadge      = document.getElementById("statusBadge");
const currentPageTitle = document.getElementById("currentPageTitle");
const currentFieldCount= document.getElementById("currentFieldCount");
const currentLastSaved = document.getElementById("currentLastSaved");
const currentPageCard  = document.getElementById("currentPageCard");
const noCurrentPage    = document.getElementById("noCurrentPage");
const btnForceRefill   = document.getElementById("btnForceRefill");
const btnDiscardSession= document.getElementById("btnDiscardSession");

const retryCount       = document.getElementById("retryCount");
const retryJobList     = document.getElementById("retryJobList");
const noRetryJobs      = document.getElementById("noRetryJobs");
const btnClearSucceeded= document.getElementById("btnClearSucceeded");

const sessionCount     = document.getElementById("sessionCount");
const sessionList      = document.getElementById("sessionList");
const noSessions       = document.getElementById("noSessions");

const toastContainer   = document.getElementById("toastContainer");

// ── State ─────────────────────────────────────────────────────────────────────

let _activeTab      = null;
let _currentStatus  = null;   // response from GET_STATUS
let _retryQueue     = [];
let _sessions       = [];     // { sessionKey, snapshot, pageTitle, pageUrl, savedAt, fieldCount }
let _refreshTimer   = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  _activeTab = await _getActiveTab();
  await _refresh();

  // Auto-refresh every 3 seconds while popup is open
  _refreshTimer = setInterval(_refresh, 3_000);

  _bindActions();
});

window.addEventListener("unload", () => clearInterval(_refreshTimer));

// ── Refresh ───────────────────────────────────────────────────────────────────

async function _refresh() {
  await Promise.all([
    _refreshCurrentPage(),
    _refreshRetryQueue(),
    _refreshSessions(),
  ]);
}

async function _refreshCurrentPage() {
  if (!_activeTab?.id) {
    _showNoCurrentPage();
    return;
  }

  try {
    const status = await _sendToTab(_activeTab.id, { type: "GET_STATUS" });
    if (!status || !status.sessionKey) { _showNoCurrentPage(); return; }

    _currentStatus = status;

    // Load saved snapshot metadata
    const key   = `pr_snapshot_${status.sessionKey}`;
    const saved = await _storageGet(key);
    const snap  = saved?.[key];

    currentPageTitle.textContent  = status.pageTitle || _truncateUrl(status.pageUrl);
    currentFieldCount.textContent = Object.keys(status.snapshot || {}).length;
    currentLastSaved.textContent  = snap?.savedAt ? _relativeTime(snap.savedAt) : "Not yet";

    currentPageCard.hidden = false;
    noCurrentPage.hidden   = true;
    _setBadge("active");

  } catch (_err) {
    _showNoCurrentPage();
  }
}

function _showNoCurrentPage() {
  currentPageCard.hidden = true;
  noCurrentPage.hidden   = false;
  _setBadge("inactive");
}

async function _refreshRetryQueue() {
  try {
    const res = await _sendToBackground({ type: "GET_RETRY_QUEUE" });
    _retryQueue = res?.queue || [];
  } catch (_) {
    _retryQueue = [];
  }
  _renderRetryQueue();
}

async function _refreshSessions() {
  try {
    const all    = await _storageGet(null); // get all storage
    _sessions = Object.entries(all)
      .filter(([k]) => k.startsWith("pr_snapshot_"))
      .map(([, v]) => v)
      .filter(Boolean)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch (_) {
    _sessions = [];
  }
  _renderSessions();
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function _renderRetryQueue() {
  const visible = _retryQueue.filter(j => j.status !== "cancelled");
  retryCount.textContent = visible.length;

  if (visible.length === 0) {
    retryJobList.innerHTML = "";
    noRetryJobs.hidden     = false;
    return;
  }
  noRetryJobs.hidden = true;

  retryJobList.innerHTML = "";
  visible.forEach(job => {
    const li = document.createElement("li");
    li.className   = "pr-job";
    li.dataset.jobId = job.id;

    const nextIn   = job.nextRetryAt > Date.now()
      ? `Next retry in ${Math.ceil((job.nextRetryAt - Date.now()) / 1000)}s`
      : "Retrying soon…";

    const attemptsText = `Attempt ${job.attempts}/${8}`;
    const errorText    = job.lastError ? ` · ${job.lastError}` : "";

    li.innerHTML = `
      <div class="pr-job__top">
        <span class="pr-job__url" title="${_esc(job.formAction || job.sessionKey)}">
          ${_esc(_truncateUrl(job.formAction || job.sessionKey))}
        </span>
        <span class="pr-job__status pr-job__status--${job.status}">
          ${job.status === "retrying" ? '<span class="pr-spinner"></span> ' : ""}${_esc(job.status)}
        </span>
      </div>
      <div class="pr-job__meta">
        ${_esc(attemptsText)}${_esc(errorText)}
        ${job.status === "pending" ? " · " + _esc(nextIn) : ""}
      </div>
      <div class="pr-job__actions">
        ${job.status === "pending" ? `<button class="pr-btn pr-btn--primary pr-btn--sm" data-action="retry-now" data-job="${_esc(job.id)}">↺ Retry Now</button>` : ""}
        ${["pending","retrying"].includes(job.status) ? `<button class="pr-btn pr-btn--danger pr-btn--sm" data-action="cancel" data-job="${_esc(job.id)}">✕ Cancel</button>` : ""}
      </div>`;

    retryJobList.appendChild(li);
  });
}

function _renderSessions() {
  sessionCount.textContent = _sessions.length;

  if (_sessions.length === 0) {
    sessionList.innerHTML = "";
    noSessions.hidden     = false;
    return;
  }
  noSessions.hidden = true;

  sessionList.innerHTML = "";
  _sessions.forEach(sess => {
    const li = document.createElement("li");
    li.className = "pr-session-item";

    const fieldCount = Object.keys(sess.snapshot || {}).length;

    li.innerHTML = `
      <div class="pr-session-item__info">
        <span class="pr-session-item__title" title="${_esc(sess.pageUrl || "")}">
          ${_esc(sess.pageTitle || _truncateUrl(sess.pageUrl || "Unknown page"))}
        </span>
        <span class="pr-session-item__meta">
          ${fieldCount} field${fieldCount !== 1 ? "s" : ""} · ${_relativeTime(sess.savedAt)}
        </span>
      </div>
      <div class="pr-session-item__actions">
        <button class="pr-btn pr-btn--ghost pr-btn--sm"
                data-action="open-session"
                data-url="${_esc(sess.pageUrl || "")}"
                title="Open this page in a new tab">↗</button>
        <button class="pr-btn pr-btn--danger pr-btn--sm"
                data-action="delete-session"
                data-key="${_esc(sess.pageUrl || sess.savedAt)}"
                title="Delete saved data">🗑</button>
      </div>`;

    sessionList.appendChild(li);
  });
}

// ── Action binding ────────────────────────────────────────────────────────────

function _bindActions() {

  // Restore fields on current page
  btnForceRefill.addEventListener("click", async () => {
    if (!_activeTab?.id || !_currentStatus) return;
    btnForceRefill.disabled = true;
    try {
      const key   = `pr_snapshot_${_currentStatus.sessionKey}`;
      const saved = await _storageGet(key);
      const snap  = saved?.[key];
      if (!snap?.snapshot) { _toast("No saved snapshot found.", "warning"); return; }
      await _sendToTab(_activeTab.id, { type: "FORCE_REFILL", snapshot: snap.snapshot });
      _toast("Fields restored!", "success");
    } catch (err) {
      _toast("Could not restore fields: " + err.message, "error");
    } finally {
      btnForceRefill.disabled = false;
    }
  });

  // Discard current session
  btnDiscardSession.addEventListener("click", async () => {
    if (!_currentStatus) return;
    if (!confirm("Delete all saved data for this page? This cannot be undone.")) return;
    try {
      await _sendToTab(_activeTab.id, {
        type:       "DISCARD_SESSION",
        sessionKey: _currentStatus.sessionKey,
      });
      _toast("Session data deleted.", "success");
      await _refresh();
    } catch (err) {
      _toast("Error: " + err.message, "error");
    }
  });

  // Clear succeeded jobs
  btnClearSucceeded.addEventListener("click", async () => {
    await _sendToBackground({ type: "CLEAR_SUCCEEDED" });
    await _refreshRetryQueue();
  });

  // Delegated click handler for job/session list actions
  document.addEventListener("click", async (evt) => {
    const btn    = evt.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === "retry-now") {
      await _sendToBackground({ type: "RETRY_NOW", jobId: btn.dataset.job });
      _toast("Retry triggered.", "success");
      await _refreshRetryQueue();
    }

    if (action === "cancel") {
      await _sendToBackground({ type: "CANCEL_JOB", jobId: btn.dataset.job });
      _toast("Job cancelled.", "warning");
      await _refreshRetryQueue();
    }

    if (action === "open-session") {
      const url = btn.dataset.url;
      if (url) chrome.tabs.create({ url });
    }

    if (action === "delete-session") {
      const rawKey = btn.dataset.key;
      if (!confirm("Delete saved data for this session?")) return;
      // Find the matching session by URL
      const sess = _sessions.find(s => (s.pageUrl || s.savedAt?.toString()) === rawKey);
      if (sess) {
        const storageKey = `pr_snapshot_${_buildPageKey(sess.pageUrl)}`;
        await new Promise(r => chrome.storage.local.remove(storageKey, r));
        _toast("Session deleted.", "success");
        await _refreshSessions();
      }
    }
  });

  // Settings button (placeholder — would open options page)
  document.getElementById("btnOpenOptions")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage?.();
  });

  // Listen for background queue updates while popup is open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "QUEUE_UPDATED") {
      _retryQueue = msg.queue || [];
      _renderRetryQueue();
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] || null));
  });
}

function _sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function _sendToBackground(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function _storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function _setBadge(state) {
  const badge = statusBadge.querySelector(".pr-badge");
  if (!badge) return;
  if (state === "active") {
    badge.className    = "pr-badge pr-badge--active";
    badge.textContent  = "Active";
  } else {
    badge.className    = "pr-badge pr-badge--inactive";
    badge.textContent  = "Inactive";
  }
}

function _relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5)    return "just now";
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function _truncateUrl(url, maxLen = 40) {
  if (!url) return "—";
  try {
    const u = new URL(url);
    const s = u.hostname + u.pathname;
    return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
  } catch (_) {
    return url.length > maxLen ? url.slice(0, maxLen) + "…" : url;
  }
}

function _buildPageKey(url) {
  try {
    const u = new URL(url);
    const blocklist = ["csrf", "token", "nonce", "sid", "_", "timestamp", "t"];
    blocklist.forEach(p => u.searchParams.delete(p));
    return u.origin + u.pathname + u.search;
  } catch (_) { return url; }
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _toast(message, type = "info") {
  const el = document.createElement("div");
  el.className   = `pr-toast pr-toast--${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3_000);
}
