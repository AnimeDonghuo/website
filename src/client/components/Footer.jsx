import { Link } from 'react-router-dom';
import { Icon } from './Icons.jsx';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer__grid">
        <div className="site-footer__brand">
          <Link className="brand" to="/" aria-label="SoraBox home">
            <span className="brand__mark" aria-hidden="true"><span /></span>
            <span>Sora<span className="brand__accent">Box</span></span>
          </Link>
          <p>A polished catalog for media delivered through Telegram — light on infrastructure, serious about discoverability.</p>
        </div>
        <div>
          <p className="site-footer__heading">Explore</p>
          <Link to="/browse/anime">Anime</Link>
          <Link to="/browse/cartoon">Cartoons</Link>
          <Link to="/browse/donghua">Donghua</Link>
          <Link to="/browse/kdrama">K-Drama</Link>
        </div>
        <div>
          <p className="site-footer__heading">Catalog</p>
          <Link to="/browse/movie">Movies</Link>
          <Link to="/browse/web-series">Web Series</Link>
          <Link to="/browse">All releases</Link>
          <Link to="/search?q=">Search</Link>
        </div>
        <div className="site-footer__promise">
          <span className="site-footer__promise-icon"><Icon name="shield" size={18} /></span>
          <p><strong>Built for your own catalog.</strong> Poster images are mirrored once to ImgBB; delivery files live in your private Telegram storage channel.</p>
        </div>
      </div>
      <div className="site-footer__bottom">
        <span>© {new Date().getFullYear()} SoraBox</span>
        <span>Use only with content you have the right to distribute.</span>
      </div>
    </footer>
  );
}
