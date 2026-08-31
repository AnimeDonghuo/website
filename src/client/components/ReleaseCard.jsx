import { Link } from 'react-router-dom';
import Artwork from './Artwork.jsx';
import { Icon } from './Icons.jsx';

function compactLanguages(languages = []) {
  const explicitLanguages = languages.filter((language) => !/^multi(?:\s+language)?$/i.test(String(language || '')));
  if (!explicitLanguages.length) return 'Language details';
  return explicitLanguages.slice(0, 2).join(' · ');
}

export default function ReleaseCard({ item, index = 0, featured = false }) {
  return (
    <article className={`release-card ${featured ? 'release-card--featured' : ''}`} style={{ '--stagger': `${index * 45}ms` }}>
      <Link className="release-card__visual-link" to={`/${item.category}/${item.slug}`} aria-label={`View ${item.title}`}>
        <Artwork item={item} className="release-card__art" priority={index < 2} />
        <div className="release-card__topline">
          <span className={`category-pill category-pill--${item.tone}`}>{item.categoryLabel}</span>
          {item.status ? <span className="release-card__status">{item.status}</span> : null}
        </div>
        <span className="release-card__open"><Icon name="arrow" size={17} /></span>
      </Link>
      <div className="release-card__body">
        <div className="release-card__meta">
          <span>{item.year || 'New'}</span>
          <span className="release-card__dot" />
          <span>{compactLanguages(item.languages)}</span>
        </div>
        <Link className="release-card__title" to={`/${item.category}/${item.slug}`}>{item.title}</Link>
        <div className="release-card__footer">
          <span>{item.releaseLabel || `${item.filesCount} files`}</span>
          <span className="release-card__file-count"><Icon name="layers" size={14} /> {item.filesCount || '—'}</span>
        </div>
      </div>
    </article>
  );
}
