/**
 * helpers.js — Shared utility functions used across all modules.
 * Runs in content script context (no ES module imports).
 */

// Expose on a single global namespace to avoid polluting window
window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.helpers = (() => {

  /**
   * Returns a stable key for a form field based on its attributes.
   * Priority: id > name > aria-label > placeholder > position index.
   */
  function getFieldKey(element, index) {
    return (
      element.id ||
      element.name ||
      element.getAttribute("aria-label") ||
      element.placeholder ||
      `field_${index}`
    );
  }

  /**
   * Returns a stable key for the current page, used as the session ID.
   * Strips query params and hashes so navigating between steps stays consistent.
   */
  function getPageKey() {
    const url = new URL(location.href);
    // Keep pathname + stable query params, drop session tokens & nonces
    const blocklist = ["csrf", "token", "nonce", "sid", "_", "timestamp", "t"];
    blocklist.forEach(p => url.searchParams.delete(p));
    return url.origin + url.pathname + url.search;
  }

  /**
   * Debounce — delays fn execution until `wait` ms have passed since last call.
   */
  function debounce(fn, wait = 400) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /**
   * Throttle — ensures fn is called at most once per `limit` ms.
   */
  function throttle(fn, limit = 1000) {
    let last = 0;
    return (...args) => {
      const now = Date.now();
      if (now - last >= limit) {
        last = now;
        fn(...args);
      }
    };
  }

  /**
   * Generates a short random ID (8 hex chars).
   */
  function uid() {
    return Math.random().toString(16).slice(2, 10);
  }

  /**
   * Safely reads a nested property without throwing.
   * e.g. safeGet(obj, "a", "b", "c") === obj?.a?.b?.c
   */
  function safeGet(obj, ...keys) {
    return keys.reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);
  }

  /**
   * Returns true if a string looks like a password / secret field name.
   * We never save these.
   */
  function isSensitiveField(element) {
    const type = (element.type || "").toLowerCase();
    const name = (element.name || element.id || "").toLowerCase();
    const sensitiveTypes = ["password", "hidden"];
    const sensitiveNames = ["password", "passwd", "pwd", "secret", "cvv", "cvc", "pin"];
    return (
      sensitiveTypes.includes(type) ||
      sensitiveNames.some(s => name.includes(s))
    );
  }

  /**
   * Formats a timestamp (ms) as a human-readable relative string.
   * e.g. "2 minutes ago", "just now"
   */
  function relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5)   return "just now";
    if (diff < 60)  return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  /**
   * Dispatches a native input + change event on an element so that
   * JavaScript frameworks (React, Angular, Vue) detect the programmatic fill.
   */
  function dispatchInputEvents(element) {
    ["input", "change", "blur"].forEach(evtName => {
      element.dispatchEvent(new Event(evtName, { bubbles: true }));
    });
  }

  /**
   * Returns true if the element is visible and interactable.
   */
  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      element.offsetWidth > 0 &&
      element.offsetHeight > 0
    );
  }

  /**
   * Clamps a number between min and max.
   */
  function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
  }

  return {
    getFieldKey,
    getPageKey,
    debounce,
    throttle,
    uid,
    safeGet,
    isSensitiveField,
    relativeTime,
    dispatchInputEvents,
    isVisible,
    clamp,
  };
})();
