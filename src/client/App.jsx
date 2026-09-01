import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { confirmAdultAccess, getConfig, getContent, getContentBySlug } from './api.js';
import AdultGate from './components/AdultGate.jsx';
import DeliveryDialog from './components/DeliveryDialog.jsx';
import Footer from './components/Footer.jsx';
import Header from './components/Header.jsx';
import { Icon } from './components/Icons.jsx';
import Artwork from './components/Artwork.jsx';
import ReleaseCard from './components/ReleaseCard.jsx';

const categoryOrder = ['anime', 'cartoon', 'donghua', 'kdrama', 'movie', 'web-series', 'adult'];
const categoryCopy = {
  anime: { eyebrow: 'ANIMATED WORLDS', title: 'Anime worth crossing worlds for.', description: 'Fresh series, feature films and hand-picked adventures gathered in one focused collection.' },
  cartoon: { eyebrow: 'ALL-AGES ADVENTURES', title: 'Bright worlds. Big imagination.', description: 'A playful corner of the catalog for family animation, classic characters and original adventures.' },
  donghua: { eyebrow: 'EASTERN FANTASY', title: 'Legends move differently here.', description: 'Explore cultivation sagas, mythic worlds and beautifully animated stories from across China.' },
  kdrama: { eyebrow: 'STORIES WITH A PULSE', title: 'One more episode energy.', description: 'Romance, mystery, comedy and high-stakes drama, organized for your next late-night watch.' },
  movie: { eyebrow: 'FEATURE PRESENTATION', title: 'Make tonight a movie night.', description: 'A curated shelf of features, from edge-of-your-seat thrillers to big-hearted adventures.' },
  'web-series': { eyebrow: 'BINGE-READY SERIES', title: 'The next tab-open-worthy series.', description: 'Smartly organized seasons and new episodes for your watchlist.' },
  adult: { eyebrow: 'AGE-RESTRICTED ACCESS', title: 'A private 18+ collection.', description: 'This area is available only after you confirm that you are 18 or older.' },
  all: { eyebrow: 'EVERYTHING TO EXPLORE', title: 'A world of stories, neatly cataloged.', description: 'Browse every release across the SoraBox catalog.' }
};

function useRemote(loader, dependencies = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let active = true;
    setState((previous) => ({ loading: true, data: previous.data, error: null }));
    loader()
      .then((data) => {
        if (active) setState({ loading: false, data, error: null });
      })
      .catch((error) => {
        if (active) setState({ loading: false, data: null, error });
      });
    return () => {
      active = false;
    };
    // loader is intentionally supplied at the callsite with dependency values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return state;
}

function PageShell({ children }) {
  return <><Header /><main>{children}</main><Footer /></>;
}

function Eyebrow({ children }) {
  return <p className="eyebrow"><span />{children}</p>;
}

function LoadingGrid({ count = 6 }) {
  return <div className="release-grid release-grid--loading">{Array.from({ length: count }, (_, index) => <div className="release-skeleton" key={index}><span /><i /><i /><b /></div>)}</div>;
}

function ErrorBlock({ error, compact = false }) {
  return (
    <div className={`error-block ${compact ? 'error-block--compact' : ''}`}>
      <Icon name="info" size={20} />
      <div><strong>Catalog temporarily unavailable</strong><p>{error?.message || 'Please refresh and try again.'}</p></div>
    </div>
  );
}

function EmptyState({ query, category }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Icon name="search" size={27} /></span>
      <h2>{query ? `Nothing matched “${query}”` : 'Nothing here yet'}</h2>
      <p>{category ? 'Try another collection or check back for the next release.' : 'A new collection is on its way.'}</p>
      <Link className="button button--secondary" to="/browse">Browse everything <Icon name="arrow" size={17} /></Link>
    </div>
  );
}

function HomePage({ onGetFiles }) {
  const catalog = useRemote(() => getContent(), []);
  const appConfig = useRemote(() => getConfig(), []);
  const items = catalog.data?.items || [];
  const featured = items.find((item) => item.featured) || items[0];
  const latest = items.slice(0, 8);
  const spotlight = items.filter((item) => item.slug !== featured?.slug).slice(0, 4);

  return (
    <PageShell>
      <section className="home-hero">
        <div className="home-hero__noise" aria-hidden="true" />
        <div className="home-hero__halo home-hero__halo--one" aria-hidden="true" />
        <div className="home-hero__halo home-hero__halo--two" aria-hidden="true" />
        <div className="home-hero__inner page-width">
          <div className="home-hero__copy">
            <Eyebrow><Icon name="spark" size={13} /> CURATED FOR TONIGHT</Eyebrow>
            {catalog.loading ? <div className="hero-title-skeleton" /> : <h1>Find your <em>next world.</em></h1>}
            <p className="home-hero__lede">A calm, carefully organized home for anime, cartoons, movies, K-drama and more — delivered through Telegram when you are ready.</p>
            <div className="hero-actions">
              <a className="button button--primary" href="#latest">Browse latest <Icon name="arrow" size={18} /></a>
              {featured ? <button type="button" className="button button--ghost" onClick={() => onGetFiles(featured)}><Icon name="telegram" size={19} /> Get featured files</button> : null}
            </div>
            <div className="hero-assurances">
              <span><Icon name="check" size={15} /> Permanent poster hosting</span>
              <span><Icon name="check" size={15} /> Private Telegram delivery</span>
            </div>
          </div>
          <div className="home-hero__feature">
            {featured ? (
              <Link className="hero-feature-card" to={`/${featured.category}/${featured.slug}`}>
                <Artwork item={featured} size="hero" priority />
                <div className="hero-feature-card__frame" aria-hidden="true" />
                <div className="hero-feature-card__caption">
                  <span className={`category-pill category-pill--${featured.tone}`}>{featured.categoryLabel}</span>
                  <strong>{featured.title}</strong>
                  <span>{featured.year || 'New'} · {featured.releaseLabel || 'Latest drop'}</span>
                </div>
                <span className="hero-feature-card__open"><Icon name="arrow" size={18} /></span>
              </Link>
            ) : <div className="hero-feature-card hero-feature-card--skeleton" />}
            <span className="hero-sticker hero-sticker--top">FRESH<br />FINDS</span>
            <span className="hero-sticker hero-sticker--bottom"><Icon name="spark" size={14} /> handpicked</span>
          </div>
        </div>
        <div className="home-hero__ticker" aria-label="Catalog types">
          <div><span>ANIME</span><i /> <span>CARTOONS</span><i /> <span>DONGHUA</span><i /> <span>K-DRAMA</span><i /> <span>MOVIES</span><i /> <span>WEB SERIES</span><i /> <span>ANIME</span><i /> <span>CARTOONS</span></div>
        </div>
      </section>

      {appConfig.data?.demoMode ? (
        <div className="demo-banner page-width"><Icon name="info" size={16} /><span><strong>Preview catalog</strong> — connect MongoDB and your Telegram bot to publish your own permanent records.</span></div>
      ) : null}

      <section className="category-rail page-width" aria-labelledby="explore-categories">
        <div className="section-heading section-heading--rail">
          <div><Eyebrow>EXPLORE BY MOOD</Eyebrow><h2 id="explore-categories">Choose a universe.</h2></div>
          <Link className="text-link" to="/browse">See everything <Icon name="arrow" size={16} /></Link>
        </div>
        <div className="category-rail__items">
          {categoryOrder.map((category, index) => {
            const label = category === 'adult' ? '18+' : category === 'web-series' ? 'Web Series' : category === 'kdrama' ? 'K-Drama' : category[0].toUpperCase() + category.slice(1);
            const icons = ['✦', '☺', '◇', '♡', '▶', '▣', '18+'];
            return <Link className={`category-tile category-tile--${category}`} key={category} to={`/browse/${category}`}>
              <span className="category-tile__number">0{index + 1}</span>
              <span className="category-tile__icon" aria-hidden="true">{icons[index]}</span>
              <span>{label}</span><Icon name="arrow" size={16} />
            </Link>;
          })}
        </div>
      </section>

      <section className="catalog-section page-width" id="latest" aria-labelledby="latest-title">
        <div className="section-heading">
          <div><Eyebrow>JUST ADDED</Eyebrow><h2 id="latest-title">Latest <em>releases.</em></h2></div>
          <Link className="text-link" to="/browse">View all releases <Icon name="arrow" size={16} /></Link>
        </div>
        {catalog.loading ? <LoadingGrid count={6} /> : catalog.error ? <ErrorBlock error={catalog.error} /> : latest.length ? <div className="release-grid">{latest.map((item, index) => <ReleaseCard key={item.id} item={item} index={index} />)}</div> : <EmptyState />}
      </section>

      <section className="spotlight page-width">
        <div className="spotlight__copy">
          <Eyebrow><Icon name="bolt" size={13} /> LOW-LIFT DELIVERY</Eyebrow>
          <h2>A big catalog without the heavy hosting bill.</h2>
          <p>Artwork is mirrored once to ImgBB. Release files are held in your Telegram database channel and copied only when someone opens a delivery link.</p>
          <div className="spotlight__stats">
            <div><strong>01</strong><span>poster copy<br />at publish time</span></div>
            <div><strong>02</strong><span>storage channel<br />for file delivery</span></div>
            <div><strong>03</strong><span>MongoDB catalog<br />for every record</span></div>
          </div>
          <Link className="button button--secondary" to="/browse">Explore the catalog <Icon name="arrow" size={18} /></Link>
        </div>
        <div className="spotlight__orbital" aria-hidden="true">
          <div className="spotlight__orbit spotlight__orbit--one" /><div className="spotlight__orbit spotlight__orbit--two" />
          <div className="spotlight__core"><span>SB</span><small>delivery<br />system</small></div>
          <span className="spotlight__satellite spotlight__satellite--one"><Icon name="telegram" size={18} /></span>
          <span className="spotlight__satellite spotlight__satellite--two"><Icon name="spark" size={16} /></span>
        </div>
      </section>

      {spotlight.length ? <section className="catalog-section catalog-section--last page-width" aria-labelledby="picked-title">
        <div className="section-heading"><div><Eyebrow>KEEP EXPLORING</Eyebrow><h2 id="picked-title">A few more <em>to save.</em></h2></div></div>
        <div className="release-grid release-grid--four">{spotlight.map((item, index) => <ReleaseCard key={item.id} item={item} index={index} />)}</div>
      </section> : null}
    </PageShell>
  );
}

function CategoryNav({ activeCategory }) {
  const active = activeCategory || 'all';
  return <nav className="browse-category-nav" aria-label="Catalog categories">
    <Link className={active === 'all' ? 'is-active' : ''} to="/browse">All</Link>
    {categoryOrder.map((category) => {
      const label = category === 'adult' ? '18+' : category === 'web-series' ? 'Series' : category === 'kdrama' ? 'K-Drama' : category[0].toUpperCase() + category.slice(1);
      return <Link key={category} className={active === category ? 'is-active' : ''} to={`/browse/${category}`}>{label}</Link>;
    })}
  </nav>;
}

function BrowsePage({ adultAccess, adultAccessVersion, onConfirmAdult, adultAccessError, confirmingAdult }) {
  const { category: requestedCategory } = useParams();
  const category = categoryOrder.includes(requestedCategory) ? requestedCategory : undefined;
  const copy = categoryCopy[category || 'all'];
  const requestedAdultCategory = category === 'adult';
  // The adult endpoint is never requested before the visitor confirms. This
  // avoids rendering, preloading, or even receiving adult cards behind a UI
  // overlay; the server independently enforces the same cookie gate.
  const catalog = useRemote(
    () => requestedAdultCategory && !adultAccess ? Promise.resolve({ items: [], total: 0 }) : getContent({ category }),
    [category, requestedAdultCategory, adultAccess, adultAccessVersion]
  );
  // A sessionStorage marker can outlive the HTTP-only server cookie. A denied
  // request returns to the same confirmation safely rather than presenting an
  // error or stale restricted data.
  const adultLocked = requestedAdultCategory && (!adultAccess || catalog.error?.status === 403);
  const [filterOpen, setFilterOpen] = useState(false);

  return (
    <PageShell>
      <section className={`browse-hero browse-hero--${category || 'all'}`}>
        <div className="page-width">
          <Eyebrow>{copy.eyebrow}</Eyebrow>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
          <CategoryNav activeCategory={category} />
        </div>
      </section>
      <section className={`browse-results page-width ${adultLocked ? 'browse-results--gated' : ''}`}>
        {adultLocked ? <AdultGate onConfirm={onConfirmAdult} confirming={confirmingAdult} error={adultAccessError} /> : <>
          <div className="browse-results__top">
            <p><strong>{catalog.loading ? '…' : catalog.data?.total || 0}</strong> release{catalog.data?.total === 1 ? '' : 's'} {category ? `in ${categoryCopy[category].title.split('.')[0]}` : 'to explore'}</p>
            <button type="button" className="filter-button" onClick={() => setFilterOpen((current) => !current)}><Icon name="filter" size={17} /> Collections <Icon name="chevron" size={15} /></button>
            <div className={`browse-filter-popover ${filterOpen ? 'browse-filter-popover--open' : ''}`}><CategoryNav activeCategory={category} /></div>
          </div>
          {catalog.loading || (requestedAdultCategory && adultAccess && !catalog.data && !catalog.error) ? <LoadingGrid count={8} /> : catalog.error ? <ErrorBlock error={catalog.error} /> : catalog.data?.items?.length ? <div className="release-grid">{catalog.data.items.map((item, index) => <ReleaseCard item={item} index={index} key={item.id} />)}</div> : <EmptyState category={category} />}
        </>}
      </section>
    </PageShell>
  );
}

function SearchPage() {
  const [params] = useSearchParams();
  const query = params.get('q')?.trim() || '';
  const catalog = useRemote(() => getContent({ query }), [query]);

  if (!query) return <Navigate to="/browse" replace />;

  return (
    <PageShell>
      <section className="search-hero page-width">
        <Eyebrow>CATALOG SEARCH</Eyebrow>
        <h1>Results for <em>“{query}”</em></h1>
        <p>Searches title, genre and available language labels across the catalog.</p>
      </section>
      <section className="browse-results page-width search-results">
        <div className="browse-results__top"><p>{catalog.loading ? 'Searching…' : <><strong>{catalog.data?.total || 0}</strong> matching release{catalog.data?.total === 1 ? '' : 's'}</>}</p><Link className="text-link" to="/browse">Clear search <Icon name="close" size={15} /></Link></div>
        {catalog.loading ? <LoadingGrid count={6} /> : catalog.error ? <ErrorBlock error={catalog.error} /> : catalog.data?.items?.length ? <div className="release-grid">{catalog.data.items.map((item, index) => <ReleaseCard item={item} index={index} key={item.id} />)}</div> : <EmptyState query={query} />}
      </section>
    </PageShell>
  );
}

function formatEpisodeNumber(value) {
  return String(value).padStart(2, '0');
}

function episodePagePath(item, group) {
  const range = group.start === group.end ? String(group.start) : `${group.start}-${group.end}`;
  return `/${item.category}/${item.slug}/episode/${range}`;
}

function watchPagePath(item) {
  return `/${item.category}/${item.slug}/watch`;
}

function parseEpisodeRoute(value) {
  const match = String(value || '').match(/^(\d{1,3})(?:-(\d{1,3}))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) return null;
  return {
    start,
    end,
    label: start === end ? `Episode ${formatEpisodeNumber(start)}` : `Episodes ${formatEpisodeNumber(start)}–${formatEpisodeNumber(end)}`
  };
}

function FileChoiceList({ item, choices, onGetFiles }) {
  return <div className="file-choice-list">
    {choices.map((file) => {
      const heading = file.episode?.label || file.label || `Delivery file ${file.position}`;
      const hasDistinctLabel = file.episode?.label && file.label && file.label.toLowerCase() !== file.episode.label.toLowerCase();
      const episodeIndex = file.episode
        ? file.episode.start === file.episode.end
          ? `EP ${formatEpisodeNumber(file.episode.start)}`
          : `EP ${formatEpisodeNumber(file.episode.start)}–${formatEpisodeNumber(file.episode.end)}`
        : `FILE ${String(file.position).padStart(2, '0')}`;
      const deliveryHref = file.deliveryUrl || file.telegramUrl;
      return <article className="file-choice" key={file.id}>
        <span className={`file-choice__index ${file.episode ? 'file-choice__index--episode' : ''}`}>{episodeIndex}</span>
        <div className="file-choice__details">
          <strong>{heading}</strong>
          {hasDistinctLabel ? <span className="file-choice__label">{file.label}</span> : null}
          <div className="file-choice__meta">
            {file.quality ? <span className="file-choice__quality">{file.quality}</span> : null}
            {file.size ? <span>{file.size}</span> : null}
            <span>{file.kind}</span>
            {file.episode?.fileCount > 1 ? <span>{file.episode.fileCount} files in this range</span> : null}
          </div>
        </div>
        {file.deliveryReady && deliveryHref ? <a className="file-choice__action" href={deliveryHref} target="_blank" rel="noreferrer" aria-label={`Get ${heading} on Telegram`}><Icon name="telegram" size={17} /> Get file</a> : <button className="file-choice__action" type="button" onClick={() => onGetFiles(item)} aria-label={`Open delivery for ${heading}`}><Icon name="telegram" size={17} /> Delivery</button>}
      </article>;
    })}
  </div>;
}

function DetailPage({ onGetFiles, adultAccess, adultAccessVersion, onConfirmAdult, adultAccessError, confirmingAdult }) {
  const { category, slug } = useParams();
  const requestedAdultCategory = category === 'adult';
  const release = useRemote(
    () => requestedAdultCategory && !adultAccess ? Promise.resolve({ item: null }) : getContentBySlug(slug),
    [slug, requestedAdultCategory, adultAccess, adultAccessVersion]
  );
  const related = useRemote(
    () => requestedAdultCategory && !adultAccess ? Promise.resolve({ items: [] }) : getContent({ category: requestedAdultCategory ? 'adult' : undefined }),
    [requestedAdultCategory, adultAccess, adultAccessVersion]
  );
  const item = release.data?.item;
  const adultLocked = (requestedAdultCategory && !adultAccess) || release.error?.status === 403;
  const relatedItems = useMemo(() => {
    if (!item) return [];
    return (related.data?.items || []).filter((entry) => entry.category === item.category && entry.slug !== item.slug).slice(0, 4);
  }, [item, related.data]);

  if (adultLocked) {
    return <PageShell><AdultGate onConfirm={onConfirmAdult} confirming={confirmingAdult} error={adultAccessError} /></PageShell>;
  }
  if (release.loading || (requestedAdultCategory && adultAccess && !item && !release.error)) {
    return <PageShell><section className="detail-loading page-width"><div /><div><span /><i /><i /><i /></div></section></PageShell>;
  }
  if (release.error || !item) {
    return <PageShell><section className="page-width not-found"><span><Icon name="info" size={28} /></span><Eyebrow>NOT FOUND</Eyebrow><h1>This release slipped through a portal.</h1><p>{release.error?.message || 'It may have been removed or the link is no longer valid.'}</p><Link className="button button--primary" to="/browse">Return to catalog <Icon name="arrow" size={18} /></Link></section></PageShell>;
  }

  return (
    <PageShell>
      <section className={`detail-hero detail-hero--${item.tone}`}>
        <div className="detail-hero__glow" aria-hidden="true" />
        <div className="detail-hero__backdrop" style={item.backdropUrl ? { backgroundImage: `url("${item.backdropUrl}")` } : undefined} aria-hidden="true" />
        <div className="page-width detail-hero__inner">
          <Link className="back-link" to={`/browse/${item.category}`}><Icon name="chevron" size={16} /> Back to {item.categoryLabel}</Link>
          <div className="detail-layout">
            <Artwork item={item} size="detail" priority className="detail-layout__art" />
            <div className="detail-layout__copy">
              <div className="detail-layout__pills"><span className={`category-pill category-pill--${item.tone}`}>{item.categoryLabel}</span><span className="status-pill"><span /> {item.status}</span></div>
              <h1>{item.title}</h1>
              <div className="detail-facts">
                {item.year ? <span><Icon name="calendar" size={15} /> {item.year}</span> : null}
                {item.releaseLabel ? <span><Icon name="clock" size={15} /> {item.releaseLabel}</span> : null}
                {item.episodeCount ? <span><Icon name="layers" size={15} /> {item.episodeCount} episode{item.episodeCount === 1 ? '' : 's'}</span> : null}
                <span><Icon name="layers" size={15} /> {item.filesCount || '—'} file{item.filesCount === 1 ? '' : 's'}</span>
              </div>
              {item.description ? <p className="detail-layout__description">{item.description}</p> : <p className="detail-layout__description detail-layout__description--muted">A catalog entry ready to be delivered via Telegram.</p>}
              <div className="tag-list">{item.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>
              <div className="detail-actions">
                {item.stream?.available ? <Link className="button button--watch" to={watchPagePath(item)}><Icon name="play" size={19} /> Watch</Link> : null}
                {item.episodeGroups?.length
                  ? <a className="button button--telegram" href="#episode-guide-title"><Icon name="layers" size={20} /> Browse episode guide</a>
                  : <button className="button button--telegram" type="button" onClick={() => onGetFiles(item)}><Icon name="telegram" size={20} /> Get all files on Telegram</button>}
                <Link className="button button--ghost" to={`/browse/${item.category}`}>More {item.categoryLabel}</Link>
              </div>
              <p className="detail-layout__delivery-note"><Icon name="shield" size={15} /> No file is hosted on this website. Telegram delivers a copy from the private storage channel.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="detail-info detail-info--single page-width">
        <div className="detail-info__languages">
          <Eyebrow>AVAILABLE LABELS</Eyebrow>
          <h2>Language & <em>release details.</em></h2>
          <p className="detail-info__track-label">Audio</p>
          <div className="language-tags">{item.languages.length ? item.languages.map((language) => <span key={language}><Icon name="check" size={14} /> {language}</span>) : <span><Icon name="check" size={14} /> Check Telegram delivery</span>}</div>
          {(item.subtitleLanguages || []).length ? <><p className="detail-info__track-label">Subtitles</p><div className="language-tags language-tags--subtitles">{item.subtitleLanguages.map((language) => <span key={language}><Icon name="check" size={14} /> {language}</span>)}</div></> : null}
          {item.episodeGroups?.length ? <p className="detail-info__episode-hint"><Icon name="arrow" size={15} /> Select an episode below to see its available files and qualities.</p> : null}
        </div>
      </section>

      {item.fileChoices?.length && !item.episodeGroups?.length ? <section className="file-choice-section page-width" aria-labelledby="file-choice-title">
        <div className="file-choice-section__heading">
          <div><Eyebrow>CHOOSE YOUR DELIVERY</Eyebrow><h2 id="file-choice-title">Pick a file or <em>quality.</em></h2><p>Every choice opens its own Telegram delivery link. Episode labels and quality tags are read from the uploaded file details.</p></div>
          <button className="button button--secondary" type="button" onClick={() => onGetFiles(item)}><Icon name="telegram" size={18} /> Get all {item.filesCount} files</button>
        </div>
        <FileChoiceList item={item} choices={item.fileChoices} onGetFiles={onGetFiles} />
      </section> : null}

      {item.episodeGroups?.length ? <section className="episode-section page-width" aria-labelledby="episode-guide-title">
        <div className="episode-section__heading">
          <div><Eyebrow>SMART EPISODE INDEX</Eyebrow><h2 id="episode-guide-title">Episode <em>guide.</em></h2></div>
          <span>{item.episodeCount || item.episodeGroups.length} indexed episode{(item.episodeCount || item.episodeGroups.length) === 1 ? '' : 's'}</span>
        </div>
        <div className="episode-grid">
          {item.episodeGroups.map((group) => <Link className="episode-card" to={episodePagePath(item, group)} key={`${group.start}-${group.end}`} aria-label={`View delivery options for ${group.label}`}>
            <span className={`episode-card__number ${group.start === group.end ? '' : 'episode-card__number--range'}`}>{group.start === group.end ? `EP ${formatEpisodeNumber(group.start)}` : `${formatEpisodeNumber(group.start)}–${formatEpisodeNumber(group.end)}`}</span>
            <strong>{group.label}</strong>
            <small>{group.fileCount} delivery file{group.fileCount === 1 ? '' : 's'} included</small>
            <Icon name="arrow" size={15} />
          </Link>)}
        </div>
        <p className="episode-section__note"><Icon name="spark" size={14} /> Built from the uploader’s cleaned caption first, with filename detection as a fallback. Select an episode to open its own delivery page and compare every available file option.</p>
      </section> : null}

      {relatedItems.length ? <section className="catalog-section catalog-section--last page-width" aria-labelledby="related-title">
        <div className="section-heading"><div><Eyebrow>MORE IN {item.categoryLabel.toUpperCase()}</Eyebrow><h2 id="related-title">Keep the <em>queue going.</em></h2></div><Link className="text-link" to={`/browse/${item.category}`}>View collection <Icon name="arrow" size={16} /></Link></div>
        <div className="release-grid release-grid--four">{relatedItems.map((entry, index) => <ReleaseCard item={entry} index={index} key={entry.id} />)}</div>
      </section> : null}
    </PageShell>
  );
}

function EpisodePage({ onGetFiles, adultAccess, adultAccessVersion, onConfirmAdult, adultAccessError, confirmingAdult }) {
  const { category, slug, episodeRange } = useParams();
  const requestedAdultCategory = category === 'adult';
  const release = useRemote(
    () => requestedAdultCategory && !adultAccess ? Promise.resolve({ item: null }) : getContentBySlug(slug),
    [slug, requestedAdultCategory, adultAccess, adultAccessVersion]
  );
  const item = release.data?.item;
  const adultLocked = (requestedAdultCategory && !adultAccess) || release.error?.status === 403;

  if (adultLocked) {
    return <PageShell><AdultGate onConfirm={onConfirmAdult} confirming={confirmingAdult} error={adultAccessError} /></PageShell>;
  }
  const requestedEpisode = parseEpisodeRoute(episodeRange);
  const matchingGroup = item?.episodeGroups?.find((group) => group.start === requestedEpisode?.start && group.end === requestedEpisode?.end);
  const episodeLabel = matchingGroup?.label || requestedEpisode?.label || 'Episode delivery';
  const choices = item && requestedEpisode
    ? (item.fileChoices || []).filter((file) => file.episode && file.episode.start <= requestedEpisode.end && file.episode.end >= requestedEpisode.start)
    : [];

  if (release.loading || (requestedAdultCategory && adultAccess && !item && !release.error)) {
    return <PageShell><section className="detail-loading page-width"><div /><div><span /><i /><i /><i /></div></section></PageShell>;
  }
  if (release.error || !item || !requestedEpisode || item.category !== category) {
    return <PageShell><section className="page-width not-found"><span><Icon name="info" size={28} /></span><Eyebrow>EPISODE NOT FOUND</Eyebrow><h1>That episode page is off the map.</h1><p>{release.error?.message || 'Return to the release and choose an available episode.'}</p><Link className="button button--primary" to={item ? `/${item.category}/${item.slug}` : '/browse'}>Return to release <Icon name="arrow" size={18} /></Link></section></PageShell>;
  }

  return (
    <PageShell>
      <section className={`detail-hero detail-hero--${item.tone} episode-page-hero`}>
        <div className="detail-hero__glow" aria-hidden="true" />
        <div className="detail-hero__backdrop" style={item.backdropUrl ? { backgroundImage: `url("${item.backdropUrl}")` } : undefined} aria-hidden="true" />
        <div className="page-width detail-hero__inner episode-page-hero__inner">
          <Link className="back-link" to={`/${item.category}/${item.slug}`}><Icon name="chevron" size={16} /> Back to {item.title}</Link>
          <div className="episode-page-hero__content">
            <Eyebrow>EPISODE DELIVERY</Eyebrow>
            <h1>{episodeLabel} <span>for</span> <em>{item.title}</em></h1>
            <p>Choose one version below. Each Telegram link delivers only that selected file, so you can pick the quality or upload that suits you.</p>
            <div className="episode-page-hero__facts">
              <span><Icon name="layers" size={15} /> {choices.length} file option{choices.length === 1 ? '' : 's'}</span>
              {item.languages.length ? <span><Icon name="check" size={15} /> {item.languages.join(' · ')}</span> : null}
              {(item.subtitleLanguages || []).length ? <span><Icon name="check" size={15} /> Subs: {item.subtitleLanguages.join(' · ')}</span> : null}
            </div>
          </div>
        </div>
      </section>

      <section className="file-choice-section file-choice-section--episode page-width" aria-labelledby="episode-file-choice-title">
        <div className="file-choice-section__heading">
          <div><Eyebrow>FILES FOR {episodeLabel.toUpperCase()}</Eyebrow><h2 id="episode-file-choice-title">Choose your <em>version.</em></h2><p>All matching uploaded files are listed here. Use a file action to open its individual Telegram delivery link.</p></div>
          <Link className="button button--secondary" to={`/${item.category}/${item.slug}`}><Icon name="layers" size={18} /> Episode guide</Link>
        </div>
        {choices.length ? <FileChoiceList item={item} choices={choices} onGetFiles={onGetFiles} /> : <div className="episode-file-empty"><Icon name="info" size={20} /><div><strong>No individual files are indexed for this episode yet.</strong><p>Return to the release page to view its available delivery options.</p></div></div>}
      </section>
    </PageShell>
  );
}

function WatchPage({ onGetFiles, adultAccess, adultAccessVersion, onConfirmAdult, adultAccessError, confirmingAdult }) {
  const { category, slug } = useParams();
  const requestedAdultCategory = category === 'adult';
  const release = useRemote(
    () => requestedAdultCategory && !adultAccess ? Promise.resolve({ item: null }) : getContentBySlug(slug),
    [slug, requestedAdultCategory, adultAccess, adultAccessVersion]
  );
  const related = useRemote(
    () => requestedAdultCategory && !adultAccess ? Promise.resolve({ items: [] }) : getContent({ category: requestedAdultCategory ? 'adult' : undefined }),
    [requestedAdultCategory, adultAccess, adultAccessVersion]
  );
  const item = release.data?.item;
  const adultLocked = (requestedAdultCategory && !adultAccess) || release.error?.status === 403;
  const entries = item?.stream?.entries || [];
  const [selectedId, setSelectedId] = useState(null);
  const selected = entries.find((entry) => entry.id === selectedId) || entries[0] || null;
  const relatedItems = useMemo(() => {
    if (!item) return [];
    return (related.data?.items || []).filter((entry) => entry.category === item.category && entry.slug !== item.slug).slice(0, 4);
  }, [item, related.data]);

  useEffect(() => {
    setSelectedId(entries[0]?.id || null);
  }, [slug, item?.stream?.updatedAt]);

  if (adultLocked) {
    return <PageShell><AdultGate onConfirm={onConfirmAdult} confirming={confirmingAdult} error={adultAccessError} /></PageShell>;
  }
  if (release.loading || (requestedAdultCategory && adultAccess && !item && !release.error)) {
    return <PageShell><section className="detail-loading page-width"><div /><div><span /><i /><i /><i /></div></section></PageShell>;
  }
  if (release.error || !item || item.category !== category) {
    return <PageShell><section className="page-width not-found"><span><Icon name="info" size={28} /></span><Eyebrow>WATCH NOT FOUND</Eyebrow><h1>This player page is off the map.</h1><p>{release.error?.message || 'Return to the release and choose an available Watch option.'}</p><Link className="button button--primary" to={item ? `/${item.category}/${item.slug}` : '/browse'}>Return to release <Icon name="arrow" size={18} /></Link></section></PageShell>;
  }
  if (!item.stream?.available || !selected) {
    return <PageShell><section className="page-width not-found"><span><Icon name="play" size={28} /></span><Eyebrow>WATCH PAGE</Eyebrow><h1>A player has not been attached yet.</h1><p>The publisher can add an authorized provider player to this existing release without changing its delivery links.</p><Link className="button button--primary" to={`/${item.category}/${item.slug}`}>Return to release <Icon name="arrow" size={18} /></Link></section></PageShell>;
  }

  const selectedTitle = selected.episode?.label || selected.label || 'Main player';
  return (
    <PageShell>
      <section className={`watch-hero detail-hero--${item.tone}`}>
        <div className="watch-hero__glow" aria-hidden="true" />
        <div className="page-width watch-hero__inner">
          <Link className="back-link" to={`/${item.category}/${item.slug}`}><Icon name="chevron" size={16} /> Back to {item.title}</Link>
          <div className="watch-hero__heading">
            <div>
              <Eyebrow><Icon name="play" size={13} /> WATCH {item.categoryLabel.toUpperCase()}</Eyebrow>
              <h1>{item.title}</h1>
              <p>{selectedTitle} · hosted by {selected.provider || item.stream.provider || 'an approved provider'}.</p>
            </div>
            <div className="watch-hero__actions">
              {selected.watchUrl ? <a className="button button--ghost" href={selected.watchUrl} target="_blank" rel="noreferrer"><Icon name="external" size={17} /> Open source</a> : null}
              {item.deliveryReady ? <button className="button button--telegram" type="button" onClick={() => onGetFiles(item)}><Icon name="telegram" size={18} /> Get files</button> : null}
            </div>
          </div>
          <div className="watch-player-shell">
            {selected.embedUrl ? <iframe
              key={selected.id}
              className="watch-player-shell__frame"
              src={selected.embedUrl}
              title={`${item.title} — ${selectedTitle}`}
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            /> : <div className="watch-player-shell__fallback"><Icon name="external" size={24} /><strong>This provider supplied an external Watch link.</strong><p>Open the approved source to play this option.</p>{selected.watchUrl ? <a className="button button--watch" href={selected.watchUrl} target="_blank" rel="noreferrer">Open player <Icon name="external" size={16} /></a> : null}</div>}
          </div>
        </div>
      </section>

      {entries.length > 1 ? <section className="watch-choices page-width" aria-labelledby="watch-choices-title">
        <div className="watch-choices__heading"><div><Eyebrow>PLAYER & EPISODE OPTIONS</Eyebrow><h2 id="watch-choices-title">Choose your <em>Watch option.</em></h2></div><span>{entries.length} approved source{entries.length === 1 ? '' : 's'}</span></div>
        <div className="watch-choices__grid">
          {entries.map((entry) => {
            const label = entry.episode?.label || entry.label || 'Main player';
            return <button className={`watch-choice ${entry.id === selected.id ? 'watch-choice--active' : ''}`} type="button" key={entry.id} onClick={() => setSelectedId(entry.id)} aria-pressed={entry.id === selected.id}>
              <span className="watch-choice__play"><Icon name="play" size={15} /></span>
              <span><strong>{label}</strong><small>{entry.provider || 'Approved provider'}{entry.embedUrl ? ' · embedded player' : ' · external player'}</small></span>
              <Icon name="arrow" size={16} />
            </button>;
          })}
        </div>
      </section> : null}

      {relatedItems.length ? <section className="catalog-section catalog-section--last page-width" aria-labelledby="watch-related-title">
        <div className="section-heading"><div><Eyebrow>MORE IN {item.categoryLabel.toUpperCase()}</Eyebrow><h2 id="watch-related-title">Keep the <em>queue going.</em></h2></div><Link className="text-link" to={`/browse/${item.category}`}>View collection <Icon name="arrow" size={16} /></Link></div>
        <div className="release-grid release-grid--four">{relatedItems.map((entry, index) => <ReleaseCard item={entry} index={index} key={entry.id} />)}</div>
      </section> : null}
    </PageShell>
  );
}

function NotFoundPage() {
  return <PageShell><section className="page-width not-found"><span><Icon name="spark" size={28} /></span><Eyebrow>404</Eyebrow><h1>That page is off the map.</h1><p>Return to the catalog and find something worth opening next.</p><Link className="button button--primary" to="/browse">Explore catalog <Icon name="arrow" size={18} /></Link></section></PageShell>;
}

export default function App() {
  const [deliveryItem, setDeliveryItem] = useState(null);
  const [adultAccess, setAdultAccess] = useState(() => {
    try {
      return window.sessionStorage.getItem('sorabox_adult_access') === '1';
    } catch {
      return false;
    }
  });
  const [confirmingAdult, setConfirmingAdult] = useState(false);
  const [adultAccessError, setAdultAccessError] = useState(null);
  const [adultAccessVersion, setAdultAccessVersion] = useState(0);

  async function handleAdultConfirmation() {
    if (confirmingAdult) return;
    setConfirmingAdult(true);
    setAdultAccessError(null);
    try {
      await confirmAdultAccess();
      try {
        window.sessionStorage.setItem('sorabox_adult_access', '1');
      } catch {
        // The server cookie still keeps this route available when storage is
        // disabled by a privacy mode or embedded browser.
      }
      setAdultAccess(true);
      // Retry a protected endpoint after renewed consent even if a restored
      // tab already held `adultAccess: true` while its server cookie expired.
      setAdultAccessVersion((version) => version + 1);
    } catch (error) {
      setAdultAccessError(error?.message || 'We could not confirm access. Please try again.');
    } finally {
      setConfirmingAdult(false);
    }
  }

  const adultGateProps = {
    adultAccess,
    adultAccessVersion,
    onConfirmAdult: handleAdultConfirmation,
    adultAccessError,
    confirmingAdult
  };

  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage onGetFiles={setDeliveryItem} />} />
        <Route path="/browse" element={<BrowsePage {...adultGateProps} />} />
        <Route path="/browse/:category" element={<BrowsePage {...adultGateProps} />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/:category/:slug/watch" element={<WatchPage onGetFiles={setDeliveryItem} {...adultGateProps} />} />
        <Route path="/:category/:slug/episode/:episodeRange" element={<EpisodePage onGetFiles={setDeliveryItem} {...adultGateProps} />} />
        <Route path="/:category/:slug" element={<DetailPage onGetFiles={setDeliveryItem} {...adultGateProps} />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      {deliveryItem ? <DeliveryDialog item={deliveryItem} onClose={() => setDeliveryItem(null)} /> : null}
    </>
  );
}
