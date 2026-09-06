import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { getCategories, getGenres } from '../api.js';
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
  // The drawer's shelf list — every category and genre — is fetched the first time it is opened,
  // never on page load. A visitor who taps Genres on a phone should not have paid for it in the
  // first paint, and the counts come from the store so they cannot be the size of one page.
  const [shelvesOpen, setShelvesOpen] = useState(false);
  const [shelves, setShelves] = useState({ loading: false, error: '', categories: [], genres: [] });
  const shelvesFetched = useRef(false);

  useEffect(() => {
    setOpen(false);
    setSearchOpen(false);
    setShelvesOpen(false);
  }, [location.pathname]);

  async function toggleShelves() {
    const next = !shelvesOpen;
    setShelvesOpen(next);
    if (!next || shelvesFetched.current) return;
    shelvesFetched.current = true;
    setShelves((previous) => ({ ...previous, loading: true }));
    try {
      const [categoryData, genreData] = await Promise.all([getCategories(), getGenres()]);
      // 18+ is never listed here: this panel is open to every visitor, and an adult shelf is only
      // reachable from its own age-confirmed route.
      setShelves({
        loading: false,
        error: '',
        categories: (categoryData.categories || []).filter((category) => category.id !== 'adult'),
        genres: genreData.genres || []
      });
    } catch (error) {
      // A failed fetch must leave the button able to try again rather than an empty panel forever.
      shelvesFetched.current = false;
      setShelves({ loading: false, error: error.message || 'The shelf list is unavailable right now.', categories: [], genres: [] });
    }
  }

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
        <div className="mobile-menu__shelves">
          <p className="mobile-menu__label">Explore</p>
          {/* Same rhythm as the rows above — a hairline, an icon, a label, a chevron — because two
              bordered boxes at the foot of a plain list is what made this block look unfinished. */}
          <button
            type="button"
            className={`mobile-menu__row ${shelvesOpen ? 'is-active' : ''}`}
            onClick={toggleShelves}
            aria-expanded={shelvesOpen}
            aria-controls="mobile-shelf-panel"
          >
            <Icon name="grid" size={17} />
            <span>Genres &amp; categories</span>
            <Icon name="chevron" size={17} className={shelvesOpen ? 'is-open' : ''} />
          </button>
          <Link className="mobile-menu__row" to="/collections">
            <Icon name="layers" size={17} />
            <span>Collections</span>
            <Icon name="chevron" size={17} />
          </Link>
          <div className={`mobile-menu__shelf-panel ${shelvesOpen ? 'is-open' : ''}`} id="mobile-shelf-panel" aria-hidden={!shelvesOpen}>
            {shelves.loading ? <p className="mobile-menu__shelf-note">Counting the catalog…</p> : null}
            {shelves.error ? (
              <p className="mobile-menu__shelf-note">{shelves.error} Close the menu and tap Genres again to retry.</p>
            ) : null}
            {shelves.categories.length ? (
              <div className="mobile-menu__shelf-group">
                <h3>Categories</h3>
                <div className="mobile-menu__shelf-list">
                  {shelves.categories.map((category) => (
                    <Link key={category.id} to={`/browse/${category.id}`} onClick={() => setOpen(false)} className={category.count ? '' : 'is-empty'}>
                      <span>{category.label}</span><small>{category.count || '—'}</small>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
            {shelves.genres.length ? (
              <div className="mobile-menu__shelf-group">
                <h3>Genres</h3>
                <div className="mobile-menu__genre-chips">
                  {/* A drawer is a thumb's reach tall, so it shows the shelves the catalog actually
                      leans on and hands the rest to the full page. */}
                  {shelves.genres.slice(0, 14).map((genre) => (
                    <Link key={genre.name} to={`/browse?genre=${encodeURIComponent(genre.name)}`} onClick={() => setOpen(false)}>
                      {genre.name}<span>{genre.count}</span>
                    </Link>
                  ))}
                </div>
                <Link className="mobile-menu__shelf-all" to="/genres" onClick={() => setOpen(false)}>
                  {shelves.genres.length > 14 ? `All ${shelves.genres.length} shelves, with counts` : 'Every shelf, with counts'} <Icon name="arrow" size={15} />
                </Link>
              </div>
            ) : null}
            {!shelves.loading && !shelves.error && !shelves.categories.length && !shelves.genres.length ? (
              <p className="mobile-menu__shelf-note">The catalog has no shelves to list yet.</p>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}
