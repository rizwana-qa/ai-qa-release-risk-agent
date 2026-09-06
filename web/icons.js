// Inline SVG icons (16px, currentColor). No icon library.

const s = (p, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
  `fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

export const ICONS = {
  check: s('<path d="M20 6 9 17l-5-5"/>'),
  x: s('<path d="M18 6 6 18M6 6l12 12"/>'),
  alert: s('<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'),
  shield: s('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>'),
  scale: s('<path d="M12 3v18M7 21h10M5 7h14M5 7 3 13a3 3 0 0 0 6 0Zm14 0-2 6a3 3 0 0 0 6 0Z"/>'),
  cpu: s('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2m6-2v2M9 20v2m6-2v2M2 9h2m-2 6h2m16-6h2m-2 6h2"/>'),
  chevron: s('<path d="m6 9 6 6 6-6"/>'),
  file: s('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>'),
  list: s('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  target: s('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  bug: s('<path d="M8 2 9.5 4M16 2l-1.5 2M12 6a4 4 0 0 0-4 4v1h8v-1a4 4 0 0 0-4-4Z"/><path d="M8 11h8v4a4 4 0 0 1-8 0v-4ZM3 13h5M16 13h5M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/>'),
  info: s('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4m0-4h.01"/>'),
  gauge: s('<path d="M12 14a2 2 0 0 0 2-2c0-1-2-6-2-6s-2 5-2 6a2 2 0 0 0 2 2Z"/><path d="M4.9 19a9 9 0 1 1 14.2 0"/>'),
  clipboard: s('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>'),
  flask: s('<path d="M9 3h6M10 3v6L5 19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1L14 9V3"/><path d="M7.5 14h9"/>'),
  route: s('<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8"/>'),
  trash: s('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>'),
  up: s('<path d="M12 19V5m-7 7 7-7 7 7"/>'),
  down: s('<path d="M12 5v14m7-7-7 7-7-7"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  play: s('<path d="M6 4l14 8-14 8Z"/>'),
  upload: s('<path d="M12 15V3m-5 5 5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  refresh: s('<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>'),
  sparkle: s('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>'),
  spinner: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" class="spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>`,
  dot: s('<circle cx="12" cy="12" r="3"/>'),
  book: s('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>'),
};
