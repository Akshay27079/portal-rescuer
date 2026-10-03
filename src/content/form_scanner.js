/**
 * form_scanner.js — Discovers and catalogues all form fields on the page.
 *
 * Runs after the DOM is ready. Handles:
 *  - Standard HTML forms
 *  - Orphaned fields (inputs outside <form> tags — common on legacy portals)
 *  - Dynamic fields added after initial page load (MutationObserver)
 *  - Shadow DOM roots (shallow, one level)
 *
 * Exposes: window.PortalRescuer.scanner
 */

window.PortalRescuer = window.PortalRescuer || {};
window.PortalRescuer.scanner = (() => {

  const { isSensitiveField, getFieldKey, isVisible } = window.PortalRescuer.helpers;

  /** Input types we track */
  const TRACKED_TYPES = new Set([
    "text", "email", "tel", "number", "url", "search",
    "date", "time", "datetime-local", "month", "week",
    "color", "range", "textarea", "select-one", "select-multiple",
    "radio", "checkbox", ""   // "" covers inputs with no type attr
  ]);

  /** CSS selector that captures all fillable elements */
  const FIELD_SELECTOR = [
    "input:not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=file]):not([type=hidden]):not([type=password])",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[contenteditable='']"
  ].join(", ");

  /**
   * Scans a root element (document or shadow root) and returns an array
   * of FieldDescriptor objects.
   *
   * FieldDescriptor {
   *   key         : string   — stable identifier
   *   element     : Element  — live DOM reference
   *   formId      : string   — id/name of parent <form>, or "__orphan__"
   *   type        : string   — input type
   *   label       : string   — resolved label text
   *   required    : boolean
   * }
   */
  function scanRoot(root = document) {
    const fields = [];
    const elements = root.querySelectorAll(FIELD_SELECTOR);

    elements.forEach((el, idx) => {
      if (isSensitiveField(el)) return;
      if (!TRACKED_TYPES.has(el.type || "")) return;

      const key      = getFieldKey(el, idx);
      const formEl   = el.closest("form");
      const formId   = formEl
        ? (formEl.id || formEl.name || formEl.action || `form_${idx}`)
        : "__orphan__";
      const label    = resolveLabel(el, root);

      fields.push({ key, element: el, formId, type: el.type || el.tagName.toLowerCase(), label, required: el.required });
    });

    return fields;
  }

  /**
   * Attempts to resolve a human-readable label for a field via:
   *  1. <label for="id">
   *  2. Wrapping <label>
   *  3. aria-label / aria-labelledby
   *  4. placeholder
   */
  function resolveLabel(el, root = document) {
    if (el.id) {
      const lbl = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const wrapping = el.closest("label");
    if (wrapping) return wrapping.textContent.replace(el.value, "").trim();

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const ariaLabelledBy = el.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      const target = root.getElementById(ariaLabelledBy);
      if (target) return target.textContent.trim();
    }

    return el.placeholder || el.name || el.id || "";
  }

  /**
   * Full page scan including one level of shadow DOM.
   */
  function scanPage() {
    let allFields = scanRoot(document);

    // One-level shadow DOM scan
    document.querySelectorAll("*").forEach(el => {
      if (el.shadowRoot) {
        allFields = allFields.concat(scanRoot(el.shadowRoot));
      }
    });

    return allFields;
  }

  /**
   * Groups an array of FieldDescriptors by their formId.
   * Returns: { [formId]: FieldDescriptor[] }
   */
  function groupByForm(fields) {
    return fields.reduce((acc, fd) => {
      if (!acc[fd.formId]) acc[fd.formId] = [];
      acc[fd.formId].push(fd);
      return acc;
    }, {});
  }

  /**
   * Watches for DOM mutations and calls `callback(newFields)` whenever
   * new fillable fields appear (e.g. single-page-app step transitions).
   * Returns a disconnect function.
   */
  function watchForNewFields(callback) {
    const seen = new WeakSet();
    const observer = new MutationObserver((mutations) => {
      const newFields = [];
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const candidates = [node, ...node.querySelectorAll(FIELD_SELECTOR)];
          candidates.forEach((el, idx) => {
            if (!el.matches || !el.matches(FIELD_SELECTOR)) return;
            if (seen.has(el)) return;
            if (isSensitiveField(el)) return;
            seen.add(el);
            newFields.push({
              key:      getFieldKey(el, idx),
              element:  el,
              formId:   el.closest("form")?.id || "__orphan__",
              type:     el.type || el.tagName.toLowerCase(),
              label:    resolveLabel(el),
              required: el.required
            });
          });
        }
      }
      if (newFields.length > 0) callback(newFields);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }

  /**
   * Reads the current value of a field descriptor.
   * Handles text, select, radio, checkbox, and contenteditable.
   */
  function readValue(fd) {
    const el = fd.element;
    if (fd.type === "checkbox") return el.checked;
    if (fd.type === "radio")    return el.checked ? el.value : null;
    if (fd.type === "select-multiple") {
      return Array.from(el.selectedOptions).map(o => o.value);
    }
    if (el.contentEditable === "true" || el.contentEditable === "") {
      return el.innerText;
    }
    return el.value;
  }

  return { scanPage, scanRoot, groupByForm, watchForNewFields, readValue, resolveLabel };
})();
