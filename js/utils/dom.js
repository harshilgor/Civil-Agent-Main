/**
 * DOM helpers — small utilities for the vanilla architecture.
 */

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function html(strings, ...values) {
  // Tagged template that just joins the strings — keeps editor highlighting.
  return strings.reduce((out, s, i) => out + s + (values[i] ?? ""), "");
}

/**
 * Replace the inner HTML of a host element only when the new markup differs.
 * For our scale of UI this is sufficient — actual DOM diffing is overkill.
 */
export function patch(host, markup) {
  if (!host) return;
  if (host.__lastMarkup === markup) return;
  host.__lastMarkup = markup;
  host.innerHTML = markup;
}

/**
 * Mount a markup string into a host once (creating the host if missing).
 */
export function mount(host, markup) {
  if (!host) return;
  host.innerHTML = markup;
  host.__lastMarkup = markup;
}

/**
 * Delegated event handler.
 *   on(root, 'click', '[data-action]', (e, target) => { ... })
 */
export function on(root, type, selector, fn) {
  if (typeof selector === "function") {
    root.addEventListener(type, selector);
    return () => root.removeEventListener(type, selector);
  }
  const handler = (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) fn(event, target);
  };
  root.addEventListener(type, handler);
  return () => root.removeEventListener(type, handler);
}

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

export function classList(...parts) {
  return parts.filter(Boolean).join(" ");
}

let __id = 0;
export function uid(prefix = "u") {
  __id += 1;
  return `${prefix}-${__id}`;
}
