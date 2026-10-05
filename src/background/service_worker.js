/**
 * service_worker.js — Background Service Worker (Manifest V3)
 *
 * Handles:
 *  1. Retry queue with exponential back-off
 *  2. Session watchdog via chrome.alarms
 *  3. HTTP error detection via webRequest (MV3-compatible)
 *  4. Message hub between content scripts and popup
 *  5. Desktop notifications
 */

// ── Constants ────────────────────────────────────────────────────────────────

const ALARM_RETRY          = "pr_retry_alarm";
const ALARM_WATCHDOG       = "pr_watchdog_alarm";
const RETRY_BASE_DELAY_MS  = 5_000;
const RETRY_MAX_DELAY_MS   = 5 * 60_000;
const RETRY_MAX_ATTEMPTS   = 8;
const WATCHDOG_INTERVAL_MIN = 1;
const RETRYABLE_STATUSES   = new Set([408, 429, 499, 500, 502, 503, 504]);

// ── State ────────────────────────────────────────────────────────────────────

let retryQueue  = [];
let watchedTabs = {};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", (evt) => {
  evt.waitUntil(clients.claim().then(_loadPersistedQueue));
});

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RETRY)    _processRetryQueue();
  if (alarm.name === ALARM_WATCHDOG) _runWatchdog();
});

// Register alarms on startup (survive SW restarts)
chrome.alarms.get(ALARM_RETRY,    (a) => { if (!a) chrome.alarms.create(ALARM_RETRY,    { periodInMinutes: 0.5 }); });
chrome.alarms.get(ALARM_WATCHDOG, (a) => { if (!a) chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: WATCHDOG_INTERVAL_MIN }); });

// ── HTTP error detection (MV3 compatible — no extraInfoSpec needed) ───────────

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!RETRYABLE_STATUSES.has(details.statusCode)) return;
    if (details.type !== "main_frame" && details.type !== "xmlhttprequest") return;

    const tabEntry = Object.entries(watchedTabs).find(([, t]) => {
      try { return t.url && details.url.startsWith(new URL(t.url).origin); }
      catch (_) { return false; }
    });
    if (!tabEntry) return;

    const [tabId, watchedTab] = tabEntry;
    chrome.storage.local.get(`pr_snapshot_${watchedTab.sessionKey}`, (res) => {
      const saved = res[`pr_snapshot_${watchedTab.sessionKey}`];
      if (!saved) return;
      _enqueueRetry({
        sessionKey:    watchedTab.sessionKey,
        formAction:    details.url,
        formMethod:    "POST",
        snapshot:      saved.snapshot,
        tabId:         parseInt(tabId),
        triggerStatus: details.statusCode,
      });
      _notifyUser(
        `🔄 HTTP ${details.statusCode} — queued for retry`,
        "Portal Rescuer will retry your submission in the background."
      );
    });
  },
  { urls: ["<all_urls>"] }
  // Note: No extra info spec — MV3 service workers cannot use "responseHeaders"
  // for blocking. We only need the status code which is always available.
);

// ── Message hub ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case "FORM_SUBMITTED":
      _registerTab(sender.tab?.id, msg.sessionKey, msg.formAction);
      sendResponse({ ok: true });
      break;

    case "FIELD_SAVED":
    case "SNAPSHOT_SAVED":
      if (sender.tab?.id && watchedTabs[sender.tab.id]) {
        watchedTabs[sender.tab.id].lastSeen = Date.now();
      }
      sendResponse({ ok: true });
      break;

    case "REPORT_ERROR": {
      const job = _enqueueRetry({
        sessionKey: msg.sessionKey,
        formAction: msg.formAction || location?.href,
        formMethod: msg.formMethod || "POST",
        snapshot:   msg.snapshot,
        tabId:      sender.tab?.id,
      });
      _notifyUser(
        "⚠️ Submission failed — retrying automatically",
        `Portal Rescuer will retry up to ${RETRY_MAX_ATTEMPTS} times.`
      );
      sendResponse({ ok: true, jobId: job?.id });
      break;
    }

    case "GET_RETRY_QUEUE":
      sendResponse({ queue: retryQueue });
      break;

    case "CANCEL_JOB": {
      const job = retryQueue.find(j => j.id === msg.jobId);
      if (job) { job.status = "cancelled"; _persistQueue(); }
      sendResponse({ ok: true });
      break;
    }

    case "RETRY_NOW": {
      const job = retryQueue.find(j => j.id === msg.jobId);
      if (job && job.status === "pending") {
        job.nextRetryAt = 0;
        _processRetryQueue();
      }
      sendResponse({ ok: true });
      break;
    }

    case "CLEAR_SUCCEEDED":
      retryQueue = retryQueue.filter(j => j.status !== "succeeded");
      _persistQueue();
      sendResponse({ ok: true });
      break;

    case "REGISTER_TAB":
      _registerTab(msg.tabId, msg.sessionKey, msg.url);
      sendResponse({ ok: true });
      break;

    case "PING":
      sendResponse({ ok: true, ts: Date.now() });
      break;

    default:
      sendResponse({ ok: false, error: `Unknown message: ${msg.type}` });
  }
  return true; // keep channel open for async responses
});

// ── Tab events ────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  delete watchedTabs[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!watchedTabs[tabId] || changeInfo.status !== "loading") return;
  try {
    const watched = watchedTabs[tabId];
    if (tab.url && !tab.url.startsWith(new URL(watched.url || "http://x").origin)) {
      delete watchedTabs[tabId];
    }
  } catch (_) {}
});

// ── Retry queue ───────────────────────────────────────────────────────────────

function _enqueueRetry({ sessionKey, formAction, formMethod, snapshot, tabId, triggerStatus }) {
  // Deduplicate — refresh snapshot if job already pending
  const existing = retryQueue.find(j => j.sessionKey === sessionKey && j.status === "pending");
  if (existing) {
    existing.snapshot = snapshot;
    _persistQueue();
    return existing;
  }

  const job = {
    id:            _uid(),
    sessionKey,
    formAction:    formAction || "",
    formMethod:    formMethod || "POST",
    snapshot:      snapshot || {},
    tabId:         tabId || null,
    attempts:      0,
    nextRetryAt:   Date.now() + RETRY_BASE_DELAY_MS,
    status:        "pending",
    createdAt:     Date.now(),
    lastError:     null,
    triggerStatus: triggerStatus || null,
  };

  retryQueue.push(job);
  _persistQueue();
  return job;
}

async function _processRetryQueue() {
  const now     = Date.now();
  const pending = retryQueue.filter(j => j.status === "pending" && j.nextRetryAt <= now);

  for (const job of pending) {
    job.status = "retrying";
    job.attempts++;
    try {
      const ok = await _attemptSubmit(job);
      if (ok) {
        job.status = "succeeded";
        _notifyUser("✅ Submission succeeded!", "Your form was submitted by Portal Rescuer.");
        if (job.tabId) {
          chrome.tabs.sendMessage(job.tabId, { type: "SUBMISSION_SUCCEEDED", jobId: job.id }).catch(() => {});
        }
      } else {
        _scheduleNextRetry(job);
      }
    } catch (err) {
      job.lastError = err.message;
      _scheduleNextRetry(job);
    }
  }

  _persistQueue();
  // Notify popup
  chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: retryQueue }).catch(() => {});
}

function _scheduleNextRetry(job) {
  if (job.attempts >= RETRY_MAX_ATTEMPTS) {
    job.status = "failed";
    _notifyUser(
      "❌ Submission failed after max retries",
      "Your data is saved. Please try submitting manually."
    );
    return;
  }
  const delay     = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, job.attempts - 1), RETRY_MAX_DELAY_MS);
  job.nextRetryAt = Date.now() + delay;
  job.status      = "pending";
}

async function _attemptSubmit(job) {
  if (!job.formAction || job.formAction === "about:blank") return false;

  // Try tab-based replay first (preserves session cookies + CSRF)
  if (job.tabId) {
    try {
      const tab = await chrome.tabs.get(job.tabId);
      if (tab && !tab.discarded) {
        await chrome.tabs.sendMessage(job.tabId, {
          type:     "REPLAY_SUBMISSION",
          jobId:    job.id,
          snapshot: job.snapshot,
        });
        return true;
      }
    } catch (_) {}
  }

  // Fallback: headless fetch (simple forms without CSRF)
  const body = new URLSearchParams();
  Object.entries(job.snapshot || {}).forEach(([k, v]) => {
    if (v != null) body.append(k, String(v));
  });

  const method = job.formMethod.toUpperCase() === "GET" ? "GET" : "POST";
  const url    = method === "GET" ? `${job.formAction}?${body}` : job.formAction;

  const res = await fetch(url, {
    method,
    credentials: "include",
    headers:     method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
    body:        method === "POST" ? body.toString() : undefined,
  });

  if (res.ok) return true;
  if (RETRYABLE_STATUSES.has(res.status)) return false;
  throw new Error(`HTTP ${res.status} — not retryable`);
}

// ── Watchdog ──────────────────────────────────────────────────────────────────

function _runWatchdog() {
  const stale = 3 * 60_000;
  const now   = Date.now();
  for (const [tabId, info] of Object.entries(watchedTabs)) {
    if (now - info.lastSeen > stale) {
      _notifyUser(
        "⚠️ Session may have timed out",
        "Portal Rescuer detected inactivity. Your data is saved."
      );
      delete watchedTabs[tabId];
    }
  }
}

function _registerTab(tabId, sessionKey, url) {
  if (!tabId) return;
  watchedTabs[tabId] = { sessionKey, url: url || "", lastSeen: Date.now() };
}

// ── Notifications ─────────────────────────────────────────────────────────────

function _notifyUser(title, message) {
  chrome.notifications.create(_uid(), {
    type:     "basic",
    iconUrl:  "assets/icons/icon48.png",
    title,
    message,
    priority: 1,
  });
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _persistQueue() {
  const toSave = retryQueue.filter(j => !["succeeded", "cancelled"].includes(j.status));
  chrome.storage.local.set({ pr_retry_queue: toSave });
}

async function _loadPersistedQueue() {
  return new Promise(resolve => {
    chrome.storage.local.get("pr_retry_queue", (res) => {
      if (Array.isArray(res.pr_retry_queue)) {
        retryQueue = res.pr_retry_queue;
      }
      resolve();
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _uid() {
  return `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
