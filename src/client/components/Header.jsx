import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icons.jsx';
import { applyTheme, currentTheme, readStoredTheme, THEME_EVENT } from '../theme.js';

const desktopLinks = [
  { label: 'Discover', to: '/' },
  { label: 'Anime', to: '/browse/anime' },
  { label: 'Cartoons', to: '/browse/cartoon' },
  { label: 'K-Drama', to: '/browse/kdrama' },
  { label: 'Browse all', to: '/browse' }
];

// Keep the compact desktop header, but never hide catalog categories in the
// mobile drawer. The 18+ destination itself presents its consent prompt before
// requesting any restricted catalog records.
const mobileLinks = [
  { label: 'Discover', to: '/' },
  { label: 'Anime', to: '/browse/anime' },
  { label: 'Cartoons', to: '/browse/cartoon' },
  { label: 'Donghua', to: '/browse/donghua' },
  { label: 'K-Drama', to: '/browse/kdrama' },
  { label: 'Movies', to: '/browse/movie' },
  { label: 'Web Series', to: '/browse/web-series' },
  { label: '18+', to: '/browse/adult' },
  { label: 'Browse all', to: '/browse' }
];

export default function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState(() => currentTheme());
  // The narrow-screen search lives in its own strip, so it needs the same open/close
  // bookkeeping the menu has: one of the two, never both, and never across a navigation.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef(null);
  const panelInput = useRef(null);

  useEffect(() => {
    setOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!searchOpen) return undefined;
    // A person tapping a search icon has already decided what to type; the field has to be
    // ready for it, and Escape has to be a way out that does not need a second tap.
    panelInput.current?.focus();
    function onKeyDown(event) {
      if (event.key === 'Escape') setSearchOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    function focusSearch(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    }
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);

  useEffect(() => {
    // The inline script in index.html has already chosen the theme before the first paint;
    // this only re-states it so the button, the mobile address-bar colour, and a stored
    // first visit agree — and keeps the two in step when another tab switches themes.
    setTheme(applyTheme(readStoredTheme()));
    function sync() {
      setTheme(currentTheme());
    }
    window.addEventListener('storage', sync);
    window.addEventListener(THEME_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(THEME_EVENT, sync);
    };
  }, []);

  function toggleTheme() {
    const next = applyTheme(theme === 'light' ? 'dark' : 'light');
    setTheme(next);
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: next }));
  }

  function submitSearch(event) {
    event.preventDefault();
    const value = query.trim();
    navigate(value ? `/search?q=${encodeURIComponent(value)}` : '/browse');
    setOpen(false);
    setSearchOpen(false);
  }

  return (
    <header className="site-header">
      <div className="site-header__shell">
        <Link className="brand" to="/" aria-label="SoraBox home">
          <span className="brand__mark" aria-hidden="true"><span /></span>
          <span>Sora<span className="brand__accent">Box</span></span>
        </Link>

        <nav className="desktop-nav" aria-label="Primary navigation">
          {desktopLinks.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.to === '/'} className={({ isActive }) => `desktop-nav__link ${isActive ? 'is-active' : ''}`}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="site-header__actions">
          <form className="header-search" onSubmit={submitSearch} role="search">
            <Icon name="search" size={18} />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a title"
              aria-label="Search the catalog"
            />
            <kbd>⌘ K</kbd>
          </form>
          {/* Same search, different shape: below the pill's breakpoint the catalog stays one
              tap away instead of hiding inside the menu. */}
          <button
            className="header-search-toggle"
            type="button"
            onClick={() => {
              setSearchOpen((value) => !value);
              setOpen(false);
            }}
            aria-label={searchOpen ? 'Close search' : 'Search titles and episodes'}
            aria-expanded={searchOpen}
          >
            <Icon name={searchOpen ? 'close' : 'search'} size={20} />
          </button>
          <Link className="header-telegram" to="/browse" aria-label="Browse Telegram-delivered releases">
            <Icon name="telegram" size={18} />
            <span>Delivery</span>
          </Link>
          <button
            className="theme-toggle"
            type="button"
            onClick={toggleTheme}
            aria-pressed={theme === 'light'}
            title={theme === 'light' ? 'Switch back to the night theme' : 'Switch to the day theme'}
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={18} />
            <span>{theme === 'light' ? 'Night' : 'Day'}</span>
          </button>
          <button className="menu-toggle" type="button" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => { setOpen((value) => !value); setSearchOpen(false); }}>
            <Icon name={open ? 'close' : 'menu'} size={22} />
          </button>
        </div>
      </div>

      <form
        className={`header-search-panel ${searchOpen ? 'header-search-panel--open' : ''}`}
        onSubmit={submitSearch}
        role="search"
        aria-hidden={!searchOpen}
      >
        <Icon name="search" size={19} />
        <input
          ref={panelInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Title, episode number, language"
          aria-label="Search titles and episodes"
          inputMode="search"
          enterKeyHint="search"
          tabIndex={searchOpen ? 0 : -1}
        />
        {query ? (
          <button type="button" className="header-search-panel__clear" aria-label="Clear search" onClick={() => setQuery('')}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </form>

      <div className={`mobile-menu ${open ? 'mobile-menu--open' : ''}`} aria-hidden={!open}>
        <form className="mobile-menu__search" onSubmit={submitSearch} role="search">
          <Icon name="search" size={19} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, genres, languages" aria-label="Search the catalog" />
        </form>
        <nav aria-label="Mobile navigation">
          {mobileLinks.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.to === '/'} className="mobile-menu__link">
              <span>{link.label}</span><Icon name="chevron" size={18} />
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
