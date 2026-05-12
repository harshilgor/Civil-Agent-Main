// SVG icon strings. Stroke-based, 24x24 viewBox, currentColor stroke.
const RAW = {
  projects: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  settings:
    '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 13a1.7 1.7 0 0 1 .3-1.5 1.7 1.7 0 0 0-.6-2.5l-1.4-.8a1.7 1.7 0 0 1-.6-1 1.7 1.7 0 0 0-1.7-1.4h-1.6a1.7 1.7 0 0 0-1.7 1.4 1.7 1.7 0 0 1-.6 1l-1.4.8a1.7 1.7 0 0 0-.6 2.5 1.7 1.7 0 0 1 .3 1.5 1.7 1.7 0 0 1-.3 1.5 1.7 1.7 0 0 0 .6 2.5l1.4.8a1.7 1.7 0 0 1 .6 1 1.7 1.7 0 0 0 1.7 1.4h1.6a1.7 1.7 0 0 0 1.7-1.4 1.7 1.7 0 0 1 .6-1l1.4-.8a1.7 1.7 0 0 0 .6-2.5 1.7 1.7 0 0 1-.3-1.5Z"/>',
  model:
    '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9"/>',
  table: '<path d="M4 5h16v14H4zM4 10h16M9 5v14"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6"/>',
  wand: '<path d="m14 4 6 6L9 21l-6-6L14 4Z"/><path d="m14 4 6 6"/>',
  layers:
    '<path d="m12 4 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
  measure: '<path d="M4 17 17 4l3 3L7 20l-3-3Z"/><path d="m13 8 3 3M9 12l2 2"/>',
  select: '<path d="m5 3 7 17 2-7 7-2L5 3Z"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/>',
  lock: '<path d="M6 10h12v10H6z"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<path d="M6 10h12v10H6z"/><path d="M8 10V7a4 4 0 0 1 7-1"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  export:
    '<path d="M14 3h7v7"/><path d="m10 14 11-11"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-4 3 2 5-7"/>',
  sparkles:
    '<path d="m12 4 1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6Z"/><path d="M19 4v3M21 5h-3"/>',
  upload:
    '<path d="M12 3v12"/><path d="m6 9 6-6 6 6"/><path d="M5 19h14"/>',
  arrow_right: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrow_down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  chevron_down: '<path d="m6 9 6 6 6-6"/>',
  chevron_left: '<path d="m15 6-6 6 6 6"/>',
  chevron_right: '<path d="m9 6 6 6-6 6"/>',
  pin: '<path d="M12 2v8"/><path d="M9 6h6"/><path d="M12 10v12"/><path d="M8 16h8"/>',
  share:
    '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8 11 8-4M8 13l8 4"/>',
  beam: '<path d="M3 9h18v6H3z"/>',
  column: '<path d="M9 3h6v18H9z"/>',
  shear_wall: '<path d="M5 3v18M9 3v18"/>',
  brace: '<path d="m4 4 16 16M20 4 4 20"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6"/>',
  paperclip:
    '<path d="m21.4 11.6-9.2 9.2a5.1 5.1 0 0 1-7.2-7.2l9.2-9.2a3.4 3.4 0 0 1 4.8 4.8l-9.2 9.2a1.7 1.7 0 0 1-2.4-2.4l8.5-8.5"/>',
  send:
    '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
};

const cache = new Map();

export function icon(name, size = 16) {
  const inner = RAW[name];
  if (!inner) return "";
  const key = `${name}@${size}`;
  if (cache.has(key)) return cache.get(key);
  const html = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${inner}</svg>`;
  cache.set(key, html);
  return html;
}

export function iconNames() {
  return Object.keys(RAW);
}
