// icons.js
//
// A single, central registry mapping an icon KEY (a plain string like
// 'building' or 'bell') to real SVG path data. Every place that draws an
// icon — the sidebar, the Admin icon picker — goes through renderIcon()
// here, never draws its own <svg> inline. That's the whole point: when a
// custom icon set is ready, replace ICONS below (or extend it) and every
// icon everywhere in the app updates, with zero changes to the sidebar,
// the schema, or the Admin UI that assign icons by key.
//
// The predefined set below is a stroke-style outline set (24x24 viewBox,
// stroke="currentColor", no fill) in the same visual family as Tabler
// Icons (MIT licensed) — chosen because it's a widely recognizable,
// neutral style that won't clash with whatever custom set eventually
// replaces it. Each entry's own SVG path content lives inline here, not
// loaded from a CDN, so the app keeps working with no internet access —
// the same reasoning as everything else in this self-hosted install.
//
// Adding a new icon later: pick a short, descriptive key (lowercase,
// hyphens for multi-word), add one entry to ICONS below with real path
// data, done — nothing else references icon keys by name except the
// Admin picker, which reads this same list automatically.

const ICONS = {
  home: '<path d="M4 12L12 4l8 8"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.5-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15 14c2.5 0 4.5 2 5 5"/>',
  bank: '<path d="M4 10h16M5 10v9M9 10v9M15 10v9M19 10v9M3 21h18M12 3l9 5H3l9-5z"/>',
  'home-dollar': '<path d="M4 12L12 4l8 8"/><path d="M6 10v10h12V10"/><path d="M12 12v2m0 4v1m-1.5-1c0 .8.7 1.5 1.5 1.5s1.5-.5 1.5-1.2c0-1.6-3-1-3-2.6 0-.7.7-1.2 1.5-1.2s1.5.7 1.5 1.5"/>',
  receipt: '<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5V3z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="1"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  wallet: '<path d="M4 7a2 2 0 012-2h11a2 2 0 012 2v2h-3a2.5 2.5 0 000 5h3v2a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"/><circle cx="16.5" cy="12" r="0.8"/>',
  'credit-card': '<rect x="3" y="6" width="18" height="13" rx="1.5"/><path d="M3 10h18M7 15h4"/>',
  'trending-up': '<path d="M4 16l6-6 4 4 6-8M14 6h6v6"/>',
  'file-invoice': '<path d="M8 3h6l4 4v14H8V3z"/><path d="M14 3v4h4M10 11h6M10 14h6M10 17h3"/>',
  calculator: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8 7h8M8 11h1M12 11h1M16 11h1M8 14h1M12 14h1M16 14h1M8 17h1M12 17h1M16 17h1"/>',
  bell: '<path d="M6 10a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z"/><path d="M10 19a2 2 0 004 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.15-1.4l2-1.5-2-3.5-2.3.9a7 7 0 00-2.4-1.4L13.7 3h-3.4l-.45 2.1a7 7 0 00-2.4 1.4l-2.3-.9-2 3.5 2 1.5A7 7 0 005 12c0 .5.05.95.15 1.4l-2 1.5 2 3.5 2.3-.9a7 7 0 002.4 1.4l.45 2.1h3.4l.45-2.1a7 7 0 002.4-1.4l2.3.9 2-3.5-2-1.5c.1-.45.15-.9.15-1.4z"/>',
  folder: '<path d="M4 6a1 1 0 011-1h4l2 2h8a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V6z"/>',
  tag: '<path d="M11 3H5a2 2 0 00-2 2v6l10 10 8-8L11 3z"/><circle cx="8" cy="8" r="1.2"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="1.5"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6M9 15h6"/>',
  'chart-bar': '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  link: '<path d="M9 15l6-6M8 12l-2.5 2.5a3 3 0 004.2 4.2L12 16M16 12l2.5-2.5a3 3 0 00-4.2-4.2L12 8"/>',
  'car': '<path d="M4 16V11l2-5h12l2 5v5"/><path d="M4 16h16M6 16v2M18 16v2"/><circle cx="7.5" cy="16" r="1.3"/><circle cx="16.5" cy="16" r="1.3"/>',
  'file-text': '<path d="M7 3h7l4 4v14H7V3z"/><path d="M14 3v4h4M9 12h6M9 15h6M9 18h3"/>',
  'currency-rupee': '<path d="M7 4h10M7 8h10M7 4c4 0 6 1.5 6 4s-2 4-6 4h-1l7 8"/>',
  layout: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9h16M9 9v11"/>',
  puzzle: '<path d="M9 4h4v2a1.5 1.5 0 003 0V4h4v4h-2a1.5 1.5 0 000 3h2v4h-4v-2a1.5 1.5 0 00-3 0v2H9v-4H7a1.5 1.5 0 010-3h2V4z"/>',
  dots: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
};

const DEFAULT_ICON = 'dots';

function renderIcon(key, opts) {
  const size = (opts && opts.size) || 18;
  const inner = ICONS[key] || ICONS[DEFAULT_ICON];
  return `<svg class="ml-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function iconKeys() {
  return Object.keys(ICONS);
}

module.exports = { ICONS, DEFAULT_ICON, renderIcon, iconKeys };
