import { icon } from "./icons.js";
import { escapeHtml } from "./dom.js";

const TONE_MAP = {
  pass: "pass",
  approved: "pass",
  ready: "pass",
  generated: "pass",
  active: "pass",
  reviewed: "pass",
  referenced: "pass",
  parsed: "pass",
  warn: "warn",
  warning: "warn",
  needs_review: "warn",
  "needs review": "warn",
  extracted: "warn",
  draft: "warn",
  fail: "fail",
  failing: "fail",
  blocked: "fail",
  default: "default",
  edited: "default",
  open: "default",
  uploaded: "default",
};

export function toneFor(status) {
  if (!status) return "default";
  const key = String(status).toLowerCase().replace(/\s+/g, "_");
  return TONE_MAP[key] || TONE_MAP[status.toLowerCase()] || "default";
}

export function statusChip(label, toneOverride) {
  const tone = toneOverride || toneFor(label);
  const text = String(label).replace(/_/g, " ");
  return `<span class="status-chip" data-tone="${tone}">${escapeHtml(text)}</span>`;
}

export function chip(label, opts = {}) {
  const cls = ["chip", opts.mono === false ? "" : "mono"].filter(Boolean).join(" ");
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

export function detailRow(label, value, opts = {}) {
  const tone = opts.tone ? ` data-tone="${opts.tone}"` : "";
  const valueClass = opts.mono === false ? "" : "";
  return `<div class="detail-row"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value ${valueClass}"${tone}>${escapeHtml(value)}</span></div>`;
}

export function metric(label, value, note) {
  return `<section class="metric">
    <p class="metric-label">${escapeHtml(label)}</p>
    <span class="metric-value">${escapeHtml(value)}</span>
    ${note ? `<span class="metric-note">${escapeHtml(note)}</span>` : ""}
  </section>`;
}

export function btn(label, opts = {}) {
  const cls = `btn ${opts.variant ? `btn-${opts.variant}` : "btn-secondary"} ${opts.size ? `btn-${opts.size}` : ""} ${opts.block ? "btn-block" : ""} ${opts.disabled ? "is-disabled" : ""}`.trim();
  const data = Object.entries(opts.data || {})
    .map(([k, v]) => `data-${k}="${escapeHtml(v)}"`)
    .join(" ");
  const ic = opts.icon ? icon(opts.icon, 14) : "";
  const label_ = label ? `<span>${escapeHtml(label)}</span>` : "";
  const disabled = opts.disabled ? "disabled aria-disabled=\"true\"" : "";
  return `<button class="${cls}" ${disabled} ${data} ${opts.id ? `id="${opts.id}"` : ""}>${ic}${label_}</button>`;
}

export function iconBtn(name, opts = {}) {
  const cls = `btn-icon ${opts.active ? "is-active" : ""}`.trim();
  const data = Object.entries(opts.data || {})
    .map(([k, v]) => `data-${k}="${escapeHtml(v)}"`)
    .join(" ");
  const aria = opts.label ? `aria-label="${escapeHtml(opts.label)}"` : "";
  const title = opts.label ? `title="${escapeHtml(opts.label)}"` : "";
  return `<button class="${cls}" ${data} ${aria} ${title}>${icon(name, 16)}</button>`;
}

export function fmtNumber(n, opts = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: opts.precision ?? 2 });
}

export function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

export function bytes(num) {
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
  return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function relativeTime(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

export function debounce(fn, delay = 200) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), delay);
  };
}

export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

export function throttleRaf(fn) {
  let pending = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}

export function mountIcon(name, size = 16) {
  return icon(name, size);
}
