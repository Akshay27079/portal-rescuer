/**
 * helpers.js — Shared utilities.
 * Exposes: window.PortalRescuer.helpers
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.helpers = (() => {

  function getFieldKey(el, index) {
    return (
      el.id ||
      el.name ||
      el.getAttribute("aria-label") ||
      el.placeholder ||
      `field_${index}`
    );
  }

  /** Stable URL key for this page — strips session tokens */
  function getPageKey() {
    try {
      const u = new URL(location.href);
      ["csrf","token","nonce","sid","_","timestamp","t","rand"].forEach(p => u.searchParams.delete(p));
      return u.origin + u.pathname + (u.search || "");
    } catch (_) {
      return location.href;
    }
  }

  function debounce(fn, wait = 400) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
  }

  function uid() {
    return Math.random().toString(16).slice(2, 10);
  }

  const SENSITIVE_TYPES = new Set(["password", "hidden"]);
  const SENSITIVE_NAMES = ["password","passwd","pwd","secret","cvv","cvc","pin"];

  function isSensitiveField(el) {
    const type = (el.type || "").toLowerCase();
    const name = (el.name || el.id || "").toLowerCase();
    return (
      SENSITIVE_TYPES.has(type) ||
      SENSITIVE_NAMES.some(s => name.includes(s))
    );
  }

  function dispatchInputEvents(el) {
    ["input", "change", "blur"].forEach(evt =>
      el.dispatchEvent(new Event(evt, { bubbles: true }))
    );
  }

  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" &&
           el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function relativeTime(ts) {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 5)    return "just now";
    if (d < 60)   return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  return { getFieldKey, getPageKey, debounce, uid, isSensitiveField, dispatchInputEvents, isVisible, relativeTime };
})();
