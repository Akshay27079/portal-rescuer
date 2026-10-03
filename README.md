# 🛡 Portal Rescuer

> **Never lose your government form progress again.**

Portal Rescuer is a browser extension that acts as an invisible safety net on top of broken, slow, or crash-prone government websites. It auto-saves everything you type, restores your work if the page crashes or times out, and quietly retries failed submissions in the background — so you never have to start over from scratch.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Quick Start](#quick-start)
3. [Loading the Extension](#loading-the-extension)
4. [How to Use It](#how-to-use-it)
5. [Architecture](#architecture)
6. [File Structure](#file-structure)
7. [Module Reference](#module-reference)
8. [Privacy & Security](#privacy--security)
9. [Known Limitations](#known-limitations)
10. [Contributing](#contributing)

---

## What It Does

### The Wrapper — A Modern Face for an Old Site
Portal Rescuer injects a clean, unobtrusive UI layer over any web page. It doesn't modify the government website itself. Instead, it adds:

- A **floating shield button** (bottom-right corner) that opens a live summary panel showing how many fields are tracked and whether any retries are in progress.
- A **recovery banner** that slides in at the top of the page whenever it detects and restores your previously saved data.
- A **save indicator chip** that confirms your data was saved, so you always know your progress is protected.

### The Session Rescuer — Your Ultimate Auto-Save
- **Saves as you type** — every field value is debounced and written to local IndexedDB storage within 600ms of you stopping.
- **Full heartbeat snapshots** — every 15 seconds a complete form snapshot is flushed to storage, even if individual field events were missed.
- **Last-chance save** — on `beforeunload` / `pagehide`, an emergency copy is written to `chrome.storage.local` before the page closes.
- **Instant restore on reload** — when you return to a page (after a crash, timeout, or accidental close), Portal Rescuer detects the saved session and refills every field automatically.
- **Retry queue with back-off** — if a form submission returns an HTTP error (408, 429, 5xx), the submission is queued and retried automatically with exponential back-off (5s → 10s → 20s … up to 5 minutes), up to 8 attempts.
- **Session watchdog** — monitors your portal tab for signs of a timeout (no activity for 3+ minutes) and alerts you before you discover the problem yourself.

---

## Quick Start

### Prerequisites
- Google Chrome 109+ or any Chromium-based browser (Edge, Brave, Arc, Opera)
- No build step required — this is a plain JavaScript extension

### 1. Download or Clone

```bash
git clone https://github.com/Akshay27079/portal-rescuer.git
# or download and unzip the release
```

### 2. Add placeholder icons (first-time setup)

The extension references PNG icons in `assets/icons/`. You need to provide these four files before loading:

```
assets/icons/icon16.png
assets/icons/icon32.png
assets/icons/icon48.png
assets/icons/icon128.png
```

Any square PNG images will work for development. You can generate them with any image editor, or use the free [Favicon Generator](https://favicon.io/) to create a matching set from a single image.

### 3. Load in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `PortalRescuer` folder (the one containing `manifest.json`)
5. The 🛡 shield icon appears in your toolbar

---

## Loading the Extension

### Chrome / Edge / Brave
```
chrome://extensions  →  Developer mode ON  →  Load unpacked  →  select PortalRescuer/
```

### Opera
```
opera://extensions  →  Developer mode ON  →  Load unpacked
```

### Firefox (coming soon)
Firefox requires Manifest V2. A compatibility build is planned.

---

## How to Use It

### Automatic protection (nothing to do)
Once installed, Portal Rescuer silently protects every form on every page. You don't need to configure anything.

1. Visit any government portal and fill in a form.
2. The save indicator (bottom-right) briefly shows **"✓ Auto-saved"** every time your data is written.
3. If the page crashes, closes, or times out — just navigate back to the same URL.
4. Portal Rescuer detects your saved session and shows the **recovery banner**: *"Session restored — 12 fields refilled from your save 2 minutes ago."*
5. All your fields are already filled in. Continue where you left off.

### Using the popup (toolbar icon)
Click the 🛡 shield icon in Chrome's toolbar to open the dashboard:

| Section | What it shows |
|---|---|
| **Current Page** | Page title, number of fields tracked, time of last save. Buttons to restore fields or discard saved data. |
| **Retry Queue** | Any submissions currently being retried. Shows attempt count, next retry time, and status. Buttons to force-retry or cancel. |
| **Saved Sessions** | All pages where Portal Rescuer has saved data. Click ↗ to reopen a page, 🗑 to delete its saved data. |

### Using the floating panel (on the portal page)
Click the **🛡 button** in the bottom-right corner of any portal page to open the in-page mini-panel:

- See field count and last save time without leaving the page.
- Click **💾 Save Now** to force an immediate snapshot.
- Click **⚙ Open Panel** to open the full popup.

### When a submission fails
If Portal Rescuer detects an error page or HTTP failure after you click Submit:

1. An **error intercept banner** appears with a **"↺ Queue Retry"** button.
2. Clicking it adds your submission to the retry queue.
3. The background service worker retries automatically — you can leave the tab or even close it.
4. A desktop notification appears when the retry succeeds or finally fails.

### Discarding saved data
If you intentionally want to start fresh on a form:
- Click **🗑 Discard** in the popup's Current Page card, or
- Click **Discard** in the recovery banner, or
- Delete the session from the Saved Sessions list.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser Tab                              │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │               Content Scripts (injected)                │   │
│  │                                                         │   │
│  │  form_scanner.js  ──►  autosave.js  ──►  db.js         │   │
│  │       │                    │               │            │   │
│  │       │ field discovery    │ debounce save │ IndexedDB  │   │
│  │       ▼                    ▼               ▼            │   │
│  │  refill.js         helpers.js       chrome.storage      │   │
│  │  (restore on load)                  (emergency backup)  │   │
│  │       │                                                  │   │
│  │       └──────►  main.js  (orchestrator)                 │   │
│  │                    │                                     │   │
│  │                    │ messages                            │   │
│  └────────────────────┼─────────────────────────────────────┘  │
│                       │                                         │
│  ┌────────────────────┼─────────────────────────────────────┐  │
│  │     overlay/       │                                      │  │
│  │     injector.js    │  (Shadow DOM — zero layout impact)   │  │
│  │     ┌──────────────┴──────────────────┐                  │  │
│  │     │  Recovery Banner                │                  │  │
│  │     │  Save Indicator chip            │                  │  │
│  │     │  Floating Panel + FAB           │                  │  │
│  │     │  Error Intercept Banner         │                  │  │
│  │     └─────────────────────────────────┘                  │  │
│  └─────────────────────────────────────────────────────────-┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ chrome.runtime.sendMessage
                             ▼
┌────────────────────────────────────────────────────────────────┐
│                  Background Service Worker                      │
│                                                                 │
│   Message Hub  ──►  Retry Queue  ──►  Exponential Back-off     │
│                          │                                      │
│   Session Watchdog       │  chrome.alarms (survives sleep)     │
│   (tab crash / timeout)  │                                      │
│                          ▼                                      │
│   webRequest.onCompleted (HTTP 5xx detection)                  │
│                          │                                      │
│                     Notifications                               │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│                      Popup UI                                   │
│                                                                 │
│   Status Dashboard  ·  Retry Queue  ·  Saved Sessions          │
│   popup.html / popup.css / popup.js                            │
└────────────────────────────────────────────────────────────────┘
```

### Data flow: typing to saved

```
User types in a field
        │
        ▼
  form_scanner.js detects input event
        │
        ▼
  autosave.js debounces (600ms)
        │
        ├──► db.saveField()  ──►  IndexedDB fields store
        │
        └──► every 15s: db.saveSnapshot()  ──►  IndexedDB snapshots store
                                           ──►  chrome.storage.local (mirror)
```

### Data flow: page reload to restored fields

```
User returns to page
        │
        ▼
  main.js calls refill.restore()
        │
        ▼
  db.loadSnapshot(sessionKey)  ──►  IndexedDB
        │                           (fallback: chrome.storage.local)
        ▼
  refill._applySnapshot(snapshot)
        │
        ├──► _fillField() for each present DOM field
        │    (dispatches native input events for React/Angular/Vue compat)
        │
        └──► _startRetryLoop() for fields not yet in DOM
             (retries every 500ms up to 8 seconds)
        │
        ▼
  overlay.showRecoveryBanner()
```

### Data flow: failed submission to retry

```
User clicks Submit  →  portal returns HTTP 503
        │
        ▼
  webRequest.onCompleted (background SW detects 503)
        │
        ▼
  _enqueueRetry({ snapshot, formAction, sessionKey })
        │
        ▼
  chrome.alarms fires every 30s
        │
        ▼
  _processRetryQueue()
        │
        ├── Tab still open?  YES → sendMessage REPLAY_SUBMISSION to content script
        │
        └── Tab closed?      YES → headless fetch POST with snapshot data
                                   (works for simple forms without CSRF tokens)
        │
        ▼
  Success: notify user, clear job
  Failure: reschedule with back-off (5s→10s→20s→40s→80s→160s→300s→give up)
```

---

## File Structure

```
PortalRescuer/
├── manifest.json                    # MV3 extension manifest
│
├── assets/
│   ├── icons/
│   │   ├── icon16.png               # Toolbar icon (16px)
│   │   ├── icon32.png               # Toolbar icon (32px)
│   │   ├── icon48.png               # Extensions page (48px)
│   │   └── icon128.png              # Chrome Web Store (128px)
│   └── styles/
│       └── overlay.css              # Host-page styles (.pr-restored highlight)
│
├── src/
│   ├── background/
│   │   └── service_worker.js        # Retry queue, watchdog, HTTP error detection
│   │
│   ├── content/
│   │   ├── main.js                  # Content script entry point / orchestrator
│   │   ├── form_scanner.js          # Field discovery, MutationObserver, shadow DOM
│   │   ├── autosave.js              # Debounced save engine + heartbeat
│   │   └── refill.js                # Session restore + deferred field fill
│   │
│   ├── overlay/
│   │   └── injector.js              # Shadow DOM UI layer (banner, panel, indicators)
│   │
│   ├── popup/
│   │   ├── popup.html               # Extension popup markup
│   │   ├── popup.css                # Popup styles (navy + teal design system)
│   │   └── popup.js                 # Popup controller (dashboard, retry, sessions)
│   │
│   ├── storage/
│   │   └── db.js                    # IndexedDB wrapper (snapshots, fields, retryJobs)
│   │
│   └── utils/
│       └── helpers.js               # Shared utilities (debounce, getPageKey, etc.)
```

---

## Module Reference

### `db.js` — Storage API

| Method | Description |
|---|---|
| `saveSnapshot(key, data)` | Upsert a full form snapshot |
| `loadSnapshot(key)` | Load snapshot by session key, or null |
| `deleteSnapshot(key)` | Delete snapshot + all its field records |
| `getAllSnapshots()` | All snapshots, sorted newest-first |
| `saveField(sessionKey, fieldKey, value)` | Per-field incremental save |
| `loadFields(sessionKey)` | Load all fields as `{ key: value }` map |
| `saveRetryJob(job)` | Persist a retry job |
| `getRetryJobs(status?)` | Get all jobs, optionally filtered by status |
| `deleteRetryJob(id)` | Remove a job |
| `clearFinishedJobs()` | Delete succeeded / cancelled / failed jobs |
| `clearOldSnapshots(days)` | Prune snapshots older than N days (default 30) |
| `getStats()` | `{ snapshots, fields, retryJobs }` counts |

### `service_worker.js` — Message API

| Message type | Direction | Payload |
|---|---|---|
| `FORM_SUBMITTED` | content → SW | `{ sessionKey, formAction, formMethod, snapshot }` |
| `REPORT_ERROR` | content → SW | `{ sessionKey, formAction, snapshot }` |
| `GET_RETRY_QUEUE` | popup → SW | — |
| `CANCEL_JOB` | popup → SW | `{ jobId }` |
| `RETRY_NOW` | popup → SW | `{ jobId }` |
| `CLEAR_SUCCEEDED` | popup → SW | — |
| `REGISTER_TAB` | any → SW | `{ tabId, sessionKey, url }` |
| `QUEUE_UPDATED` | SW → popup | `{ queue }` |
| `SUBMISSION_SUCCEEDED` | SW → content | `{ jobId }` |
| `REPLAY_SUBMISSION` | SW → content | `{ jobId, snapshot }` |

### `main.js` — Content Script Message API

| Message type | Direction | Description |
|---|---|---|
| `GET_STATUS` | popup → content | Returns current session key, snapshot, page info |
| `FORCE_REFILL` | popup → content | Fills fields from provided snapshot |
| `DISCARD_SESSION` | popup → content | Deletes saved data for the session key |
| `SHOW_OVERLAY` | any → content | Opens the floating panel |
| `HIDE_OVERLAY` | any → content | Closes the floating panel |

---

## Privacy & Security

**All data stays on your device.** Portal Rescuer never sends your form data to any external server.

- Form data is stored in **IndexedDB** (local browser storage, isolated per browser profile).
- A backup copy goes to **`chrome.storage.local`** (also local, also isolated).
- The retry queue uses **headless fetch with `credentials: "include"`** — meaning it sends your existing browser cookies, exactly as if you clicked Submit yourself. No credentials are ever stored by the extension.
- **Passwords are never saved.** Any field with `type="password"` or a name matching common password patterns (`password`, `pwd`, `cvv`, `pin`, etc.) is explicitly excluded from all saving.
- **Hidden fields are never saved.** `type="hidden"` inputs are skipped.
- Saved snapshots are **automatically pruned after 30 days**.

---

## Known Limitations

| Limitation | Detail |
|---|---|
| **CSRF-protected forms** | Headless fetch retries will fail on forms that require a fresh CSRF token per submission. The tab-based retry path (replaying via the open tab) handles this correctly. |
| **File upload fields** | `type="file"` inputs are excluded — browsers don't allow programmatic file selection for security reasons. |
| **Multi-step wizard forms** | If a portal splits a long form across multiple pages, Portal Rescuer saves each page independently. Cross-page navigation is handled via the SPA listener but multi-domain redirects may break the session key. |
| **Captcha fields** | CAPTCHA responses expire quickly and cannot be replayed. Portal Rescuer saves all other fields so you only need to re-solve the CAPTCHA. |
| **Firefox** | Manifest V3 with service workers is not yet fully supported in Firefox. A MV2 compatibility build is planned. |
| **Iframes** | The content script runs in the top-level frame only (`all_frames: false`). Portals that load their forms in cross-origin iframes are not currently supported. |

---

## Contributing

Pull requests are welcome. Please open an issue first to discuss significant changes.

### Development tips

- Load the extension unpacked from `chrome://extensions` with **Developer mode** on.
- Use **Inspect views: service worker** on the extensions page to debug background script logs.
- Right-click any portal page → **Inspect** → **Console** to see content script logs (all prefixed `[PortalRescuer]`).
- To test the retry queue without a real failing server, open the popup and manually trigger a retry via the **Retry Now** button on a queued job.
- To wipe all saved data during development, open the browser console on any page and run:
  ```js
  window.PortalRescuer.db.nukeDatabase()
  ```

### Roadmap

- [ ] Firefox (MV2) compatibility build
- [ ] Cross-origin iframe support
- [ ] Options page (configure save interval, max age, excluded domains)
- [ ] Export/import saved sessions as JSON
- [ ] Visual form diff — highlight which fields changed since last save
- [ ] Chrome Web Store release

---

*Portal Rescuer is an independent open-source tool. It is not affiliated with, endorsed by, or connected to any government agency or portal.*
