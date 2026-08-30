import { useState } from 'react';

function titleInitials(title) {
  return String(title || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0])
    .join('')
    .toUpperCase() || 'SB';
}

// The client uses a styled fallback while a real catalog item loads its ImgBB-hosted poster.
export default function Artwork({ item, size = 'card', priority = false, className = '' }) {
  const [imageFailed, setImageFailed] = useState(false);
  const tone = item.tone || item.art?.tone || 'violet';
  const showImage = Boolean(item.posterUrl && !imageFailed);
  const mark = item.art?.mark || titleInitials(item.title);

  return (
    <div className={`artwork artwork--${tone} artwork--${size} ${className}`.trim()}>
      {showImage ? (
        <img
          className="artwork__image"
          src={item.posterUrl}
          alt={`${item.title} poster`}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          onError={() => setImageFailed(true)}
        />
      ) : null}
      <div className={`artwork__fallback ${showImage ? 'artwork__fallback--behind' : ''}`} aria-hidden="true">
        <span className="artwork__constellation artwork__constellation--one" />
        <span className="artwork__constellation artwork__constellation--two" />
        <span className="artwork__ring" />
        <span className="artwork__mark">{mark}</span>
        <span className="artwork__type">{item.categoryLabel || item.category || 'Collection'}</span>
      </div>
      <div className="artwork__shade" aria-hidden="true" />
    </div>
  );
}
