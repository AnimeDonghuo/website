import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './Icons.jsx';

const primaryLinks = [
  { label: 'Discover', to: '/' },
  { label: 'Anime', to: '/browse/anime' },
  { label: 'Cartoons', to: '/browse/cartoon' },
  { label: 'K-Drama', to: '/browse/kdrama' },
  { label: 'Browse all', to: '/browse' }
];

export default function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInput = useRef(null);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

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

  function submitSearch(event) {
    event.preventDefault();
    const value = query.trim();
    navigate(value ? `/search?q=${encodeURIComponent(value)}` : '/browse');
    setOpen(false);
  }

  return (
    <header className="site-header">
      <div className="site-header__shell">
        <Link className="brand" to="/" aria-label="SoraBox home">
          <span className="brand__mark" aria-hidden="true"><span /></span>
          <span>Sora<span className="brand__accent">Box</span></span>
        </Link>

        <nav className="desktop-nav" aria-label="Primary navigation">
          {primaryLinks.map((link) => (
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
          <Link className="header-telegram" to="/browse" aria-label="Browse Telegram-delivered releases">
            <Icon name="telegram" size={18} />
            <span>Delivery</span>
          </Link>
          <button className="menu-toggle" type="button" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <Icon name={open ? 'close' : 'menu'} size={22} />
          </button>
        </div>
      </div>

      <div className={`mobile-menu ${open ? 'mobile-menu--open' : ''}`} aria-hidden={!open}>
        <form className="mobile-menu__search" onSubmit={submitSearch} role="search">
          <Icon name="search" size={19} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, genres, languages" aria-label="Search the catalog" />
        </form>
        <nav aria-label="Mobile navigation">
          {primaryLinks.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.to === '/'} className="mobile-menu__link">
              <span>{link.label}</span><Icon name="chevron" size={18} />
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
