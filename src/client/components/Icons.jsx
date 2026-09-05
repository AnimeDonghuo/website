export function Icon({ name, size = 20, stroke = 1.9, className = '' }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    'aria-hidden': true
  };

  const paths = {
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.2 4.2" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    arrow: <><path d="M5 12h13" /><path d="m13 7 5 5-5 5" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    play: <path d="m9 7 8 5-8 5V7Z" fill="currentColor" stroke="none" />,
    telegram: <><path d="m21.4 3.3-3 16.3c-.2 1.1-1 1.4-1.9.9l-5.3-3.9-2.6 2.5c-.3.3-.5.5-1.1.5l.4-5.4 9.8-8.8c.4-.4-.1-.6-.7-.2L5 12.8l-5.2-1.6c-1.1-.3-1.1-1.1.2-1.6L20.3 1.8c.9-.3 1.7.2 1.1 1.5Z" /></>,
    download: <><path d="M12 3v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></>,
    spark: <path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z" />,
    check: <path d="m5 12 4.2 4.2L19 6.5" />,
    calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></>,
    layers: <><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5" /><path d="m4 16.5 8 4.5 8-4.5" /></>,
    shield: <><path d="M12 3 5.5 5.6v5.6c0 4.2 2.7 7.6 6.5 9.8 3.8-2.2 6.5-5.6 6.5-9.8V5.6L12 3Z" /><path d="m9 12 2 2 4-4" /></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    copy: <><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></>,
    external: <><path d="M14 5h5v5" /><path d="m19 5-9 9" /><path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" /></>,
    bolt: <path d="m13 2-8 12h6l-1 8 9-13h-6l0-7Z" />,
    filter: <><path d="M4 6h16M7 12h10M10 18h4" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>,
    sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" /></>,
    moon: <path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4Z" />,
    expand: <><path d="M9 3H3v6" /><path d="M15 21h6v-6" /><path d="M3 15v6h6" /><path d="M21 9V3h-6" /></>
  };

  return <svg {...common}>{paths[name] || paths.spark}</svg>;
}
