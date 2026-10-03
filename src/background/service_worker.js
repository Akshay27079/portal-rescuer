/**
 * service_worker.js — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  1. RETRY QUEUE     — When a form submission fails, queue it and retry
 *                       with exponential back-off until it succeeds or
 *                       the user cancels.
 *  2. SESSION WATCHDOG — Detect tab crashes, navigations away, and 401/5xx
 *                        HTTP errors on portal pages; alert the user.
 *  3. ALARM SCHEDULER  — Use chrome.alarms to wake the worker and process
 *                        the retry queue (MV3 service workers can sleep).
 *  4. MESSAGE HUB      — Relay messages between content scripts and popup.
 *  5. NOTIFICATION     — Inform the user when data is saved or a retry succeeds.
 */

// ── Constants ───────────────────────────────────────────────────────────────

const ALARM_RETRY     = "pr_retry_alarm";
const ALARM_WATCHDOG  = "pr_watchdog_alarm";

/** Minimum delay (ms) before first retry after a failure */
const RETRY_BASE_DELAY_MS  = 5_000;
/** Maximum delay (ms) — caps the exponential back-off */
const RETRY_MAX_DELAY_MS   = 5 * 60_000; // 5 minutes
/** Give up after this many attempts */
const RETRY_MAX_ATTEMPTS   = 8;
/** HTTP status codes considered "transient" and worth retrying */
const RETRYABLE_STATUSES   = new Set([408, 429, 499, 500, 502, 503, 504]);
/** How often (minutes) the watchdog alarm fires */
const WATCHDOG_INTERVAL_MIN = 1;

// ── State (in-memory; backed by chrome.storage for persistence) ─────────────

let retryQueue = [];   // Array<RetryJob>
let watchedTabs = {};  // tabId → { sessionKey, url, lastSeen }

/*
 * RetryJob {
 *   id          : string   — unique job id
 *   sessionKey  : string   — page URL key
 *   formAction  : string   — form submit URL
 *   formMethod  : string   — GET | POST
 *   snapshot    : object   — { fieldKey: value }
 *   attempts    : number   — how many times we've tried
 *   nextRetryAt : number   — epoch ms of next attempt
 *   status      : "pending" | "retrying" | "succeeded" | "failed" | "cancelled"
 *   createdAt   : number
 *   lastError   : string | null
 * }
 */

// ── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", (evt) => {
  evt.waitUntil(clients.claim().then(_loadPersistedQueue));
});

// ── Alarm handlers ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RETRY)    _processRetryQueue();
  if (alarm.name === ALARM_WATCHDOG) _runWatchdog();
});

// Ensure alarms are registered (they survive service worker restarts)
chrome.alarms.get(ALARM_RETRY,    a => { if (!a) chrome.alarms.create(ALARM_RETRY,    { periodInMinutes: 0.5 }); });
chrome.alarms.get(ALARM_WATCHDOG, a => { if (!a) chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: WATCHDOG_INTERVAL_MIN }); });

// ── Message hub ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case "FORM_SUBMITTED":
      // Content script notified us a form was submitted — watch this tab
      _registerTab(sender.tab?.id, msg.sessionKey, msg.formAction);
      sendResponse({ ok: true });
      break;

    case "FIELD_SAVED":
    case "SNAPSHOT_SAVED":
      // Update watchdog's last-seen timestamp for this tab
      if (sender.tab?.id && watchedTabs[sender.tab.id]) {
        watchedTabs[sender.tab.id].lastSeen = Date.now();
      }
      sendResponse({ ok: true });
      break;

    case "REPORT_ERROR": {
      // Content script detected an error page / timeout
      const job = _enqueueRetry({
        sessionKey: msg.sessionKey,
        formAction: msg.formAction,
        formMethod: msg.formMethod || "POST",
        snapshot:   msg.snapshot,
        tabId:      sender.tab?.id,
      });
      _notifyUser(
        "⚠️ Submission failed — retrying automatically",
        `Portal Rescuer will retry your submission up to ${RETRY_MAX_ATTEMPTS} times.`,
        "error"
      );
      sendResponse({ ok: true, jobId: job.id });
      break;
    }

    case "GET_RETRY_QUEUE":
      sendResponse({ queue: retryQueue });
      break;

    case "CANCEL_JOB": {
      const job = retryQueue.find(j => j.id === msg.jobId);
      if (job) {
        job.status = "cancelled";
        _persistQueue();
      }
      sendResponse({ ok: true });
      break;
    }

    case "RETRY_NOW": {
      const job = retryQueue.find(j => j.id === msg.jobId);
      if (job && job.status === "pending") {
        job.nextRetryAt = 0; // force immediate
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
      sendResponse({ ok: false, error: "Unknown message type" });
  }

  return true; // keep channel open for async responses
});

// ── Tab event listeners (session watchdog support) ────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  delete watchedTabs[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!watchedTabs[tabId]) return;
  if (changeInfo.status !== "loading") return;

  const watched = watchedTabs[tabId];
  // If the tab navigated away from the portal entirely, stop watching
  if (tab.url && !tab.url.startsWith(new URL(watched.url || "http://x").origin)) {
    console.debug("[PortalRescuer SW] Tab navigated away from portal:", tabId);
    delete watchedTabs[tabId];
  }
});

// Detect HTTP errors via webRequest
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!RETRYABLE_STATUSES.has(details.statusCode)) return;
    if (details.type !== "main_frame" && details.type !== "xmlhttprequest") return;

    // Find the tab watching this URL
    const tabEntry = Object.entries(watchedTabs).find(
      ([, t]) => t.url && details.url.startsWith(new URL(t.url).origin)
    );
    if (!tabEntry) return;

    const [tabId, watchedTab] = tabEntry;
    console.warn(`[PortalRescuer SW] HTTP ${details.statusCode} detected on tab ${tabId}`);

    // Pull the latest snapshot from storage and enqueue a retry
    chrome.storage.local.get(`pr_snapshot_${watchedTab.sessionKey}`, (res) => {
      const saved = res[`pr_snapshot_${watchedTab.sessionKey}`];
      if (!saved) return;

      _enqueueRetry({
        sessionKey: watchedTab.sessionKey,
        formAction: details.url,
        formMethod: "POST",
        snapshot:   saved.snapshot,
        tabId:      parseInt(tabId),
        triggerStatus: details.statusCode,
      });

      _notifyUser(
        `🔄 HTTP ${details.statusCode} — queued for retry`,
        "Portal Rescuer will retry your submission in the background.",
        "error"
      );
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ── Retry Queue ──────────────────────────────────────────────────────────────

function _enqueueRetry({ sessionKey, formAction, formMethod, snapshot, tabId, triggerStatus }) {
  const existing = retryQueue.find(
    j => j.sessionKey === sessionKey && j.status === "pending"
  );
  if (existing) {
    // Refresh snapshot on duplicate — don't add another job
    existing.snapshot = snapshot;
    _persistQueue();
    return existing;
  }

  const job = {
    id:          _uid(),
    sessionKey,
    formAction,
    formMethod:  formMethod || "POST",
    snapshot,
    tabId:       tabId || null,
    attempts:    0,
    nextRetryAt: Date.now() + RETRY_BASE_DELAY_MS,
    status:      "pending",
    createdAt:   Date.now(),
    lastError:   null,
    triggerStatus: triggerStatus || null,
  };

  retryQueue.push(job);
  _persistQueue();
  console.info("[PortalRescuer SW] Job enqueued:", job.id, sessionKey);
  return job;
}

async function _processRetryQueue() {
  const now     = Date.now();
  const pending = retryQueue.filter(j => j.status === "pending" && j.nextRetryAt <= now);

  for (const job of pending) {
    job.status = "retrying";
    job.attempts++;

    try {
      const success = await _attemptSubmit(job);
      if (success) {
        job.status = "succeeded";
        _notifyUser(
          "✅ Submission succeeded!",
          "Your form was submitted successfully by Portal Rescuer.",
          "success"
        );
        // Tell the tab to clear the recovery banner
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
  // Notify popup to refresh its display
  chrome.runtime.sendMessage({ type: "QUEUE_UPDATED", queue: retryQueue }).catch(() => {});
}

function _scheduleNextRetry(job) {
  if (job.attempts >= RETRY_MAX_ATTEMPTS) {
    job.status = "failed";
    _notifyUser(
      "❌ Submission failed after maximum retries",
      "Portal Rescuer could not submit your form. Your data is saved — please try again manually.",
      "error"
    );
    return;
  }

  // Exponential back-off: base * 2^(attempts-1), capped at max
  const delay = Math.min(
    RETRY_BASE_DELAY_MS * Math.pow(2, job.attempts - 1),
    RETRY_MAX_DELAY_MS
  );
  job.nextRetryAt = Date.now() + delay;
  job.status      = "pending";
  console.debug(`[PortalRescuer SW] Job ${job.id} retry ${job.attempts}/${RETRY_MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
}

/**
 * Attempts to re-submit the form by sending the snapshot as a POST/GET body.
 * Note: This works for simple non-CSRF form submissions. Government portals
 * with CSRF tokens will need the tab-based retry path (navigating the actual tab).
 * Returns true on success, false on retryable failure, throws on hard error.
 */
async function _attemptSubmit(job) {
  if (!job.formAction || job.formAction === "about:blank") return false;

  // If the originating tab is still open, prefer redirecting it to retry
  if (job.tabId) {
    try {
      const tab = await chrome.tabs.get(job.tabId);
      if (tab && !tab.discarded) {
        // Ask the content script to replay the submission
        await chrome.tabs.sendMessage(job.tabId, {
          type:    "REPLAY_SUBMISSION",
          jobId:   job.id,
          snapshot: job.snapshot,
        });
        // Assume success for now; content script will report back via FORM_SUBMITTED
        return true;
      }
    } catch (_) { /* tab gone, fall through to fetch */ }
  }

  // Headless fetch retry (works for simple POST forms)
  const body   = new URLSearchParams();
  const snapshot = job.snapshot || {};
  Object.entries(snapshot).forEach(([k, v]) => {
    if (v !== null && v !== undefined) body.append(k, String(v));
  });

  const options = {
    method:      job.formMethod.toUpperCase() === "GET" ? "GET" : "POST",
    credentials: "include",
    headers:     { "Content-Type": "application/x-www-form-urlencoded" },
  };
  if (options.method === "POST") {
    options.body = body.toString();
  }

  const url = options.method === "GET"
    ? `${job.formAction}?${body.toString()}`
    : job.formAction;

  const res = await fetch(url, options);

  if (res.ok)                          return true;
  if (RETRYABLE_STATUSES.has(res.status)) return false; // schedule retry
  // 4xx other than retryable = permanent failure
  throw new Error(`HTTP ${res.status} — not retryable`);
}

// ── Watchdog ─────────────────────────────────────────────────────────────────

function _runWatchdog() {
  const staleThreshold = 3 * 60_000; // 3 minutes without a heartbeat
  const now = Date.now();

  for (const [tabId, info] of Object.entries(watchedTabs)) {
    if (now - info.lastSeen > staleThreshold) {
      console.warn(`[PortalRescuer SW] Watchdog: tab ${tabId} has gone quiet.`);
      _notifyUser(
        "⚠️ Session may have timed out",
        "Portal Rescuer detected inactivity on your government portal. Your data is saved.",
        "warning"
      );
      // Don't spam — remove from watched after warning once
      delete watchedTabs[tabId];
    }
  }
}

function _registerTab(tabId, sessionKey, url) {
  if (!tabId) return;
  watchedTabs[tabId] = { sessionKey, url: url || "", lastSeen: Date.now() };
  console.debug("[PortalRescuer SW] Watching tab:", tabId, sessionKey);
}

// ── Notifications ─────────────────────────────────────────────────────────────

function _notifyUser(title, message, type = "info") {
  const iconMap = {
    success: "assets/icons/icon48.png",
    error:   "assets/icons/icon48.png",
    warning: "assets/icons/icon48.png",
    info:    "assets/icons/icon48.png",
  };

  chrome.notifications.create(_uid(), {
    type:    "basic",
    iconUrl: iconMap[type] || iconMap.info,
    title,
    message,
    priority: type === "error" ? 2 : 1,
  });
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _persistQueue() {
  // Only persist non-succeeded/non-cancelled jobs to keep storage lean
  const toSave = retryQueue.filter(j => !["succeeded", "cancelled"].includes(j.status));
  chrome.storage.local.set({ pr_retry_queue: toSave });
}

async function _loadPersistedQueue() {
  return new Promise(resolve => {
    chrome.storage.local.get("pr_retry_queue", (res) => {
      if (res.pr_retry_queue && Array.isArray(res.pr_retry_queue)) {
        retryQueue = res.pr_retry_queue;
        console.info(`[PortalRescuer SW] Loaded ${retryQueue.length} persisted retry jobs.`);
      }
      resolve();
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _uid() {
  return `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
