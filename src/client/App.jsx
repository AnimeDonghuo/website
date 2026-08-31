import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { getConfig, getContent, getContentBySlug } from './api.js';
import DeliveryDialog from './components/DeliveryDialog.jsx';
import Footer from './components/Footer.jsx';
import Header from './components/Header.jsx';
import { Icon } from './components/Icons.jsx';
import Artwork from './components/Artwork.jsx';
import ReleaseCard from './components/ReleaseCard.jsx';

const categoryOrder = ['anime', 'cartoon', 'donghua', 'kdrama', 'movie', 'web-series'];
const categoryCopy = {
  anime: { eyebrow: 'ANIMATED WORLDS', title: 'Anime worth crossing worlds for.', description: 'Fresh series, feature films and hand-picked adventures gathered in one focused collection.' },
  cartoon: { eyebrow: 'ALL-AGES ADVENTURES', title: 'Bright worlds. Big imagination.', description: 'A playful corner of the catalog for family animation, classic characters and original adventures.' },
  donghua: { eyebrow: 'EASTERN FANTASY', title: 'Legends move differently here.', description: 'Explore cultivation sagas, mythic worlds and beautifully animated stories from across China.' },
  kdrama: { eyebrow: 'STORIES WITH A PULSE', title: 'One more episode energy.', description: 'Romance, mystery, comedy and high-stakes drama, organized for your next late-night watch.' },
  movie: { eyebrow: 'FEATURE PRESENTATION', title: 'Make tonight a movie night.', description: 'A curated shelf of features, from edge-of-your-seat thrillers to big-hearted adventures.' },
  'web-series': { eyebrow: 'BINGE-READY SERIES', title: 'The next tab-open-worthy series.', description: 'Smartly organized seasons and new episodes for your watchlist.' },
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
            const label = category === 'web-series' ? 'Web Series' : category === 'kdrama' ? 'K-Drama' : category[0].toUpperCase() + category.slice(1);
            const icons = ['✦', '☺', '◇', '♡', '▶', '▣'];
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
      const label = category === 'web-series' ? 'Series' : category === 'kdrama' ? 'K-Drama' : category[0].toUpperCase() + category.slice(1);
      return <Link key={category} className={active === category ? 'is-active' : ''} to={`/browse/${category}`}>{label}</Link>;
    })}
  </nav>;
}

function BrowsePage() {
  const { category: requestedCategory } = useParams();
  const category = categoryOrder.includes(requestedCategory) ? requestedCategory : undefined;
  const copy = categoryCopy[category || 'all'];
  const catalog = useRemote(() => getContent({ category }), [category]);
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
      <section className="browse-results page-width">
        <div className="browse-results__top">
          <p><strong>{catalog.loading ? '…' : catalog.data?.total || 0}</strong> release{catalog.data?.total === 1 ? '' : 's'} {category ? `in ${categoryCopy[category].title.split('.')[0]}` : 'to explore'}</p>
          <button type="button" className="filter-button" onClick={() => setFilterOpen((current) => !current)}><Icon name="filter" size={17} /> Collections <Icon name="chevron" size={15} /></button>
          <div className={`browse-filter-popover ${filterOpen ? 'browse-filter-popover--open' : ''}`}><CategoryNav activeCategory={category} /></div>
        </div>
        {catalog.loading ? <LoadingGrid count={8} /> : catalog.error ? <ErrorBlock error={catalog.error} /> : catalog.data?.items?.length ? <div className="release-grid">{catalog.data.items.map((item, index) => <ReleaseCard item={item} index={index} key={item.id} />)}</div> : <EmptyState category={category} />}
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

function DetailPage({ onGetFiles }) {
  const { slug } = useParams();
  const release = useRemote(() => getContentBySlug(slug), [slug]);
  const related = useRemote(() => getContent(), []);
  const item = release.data?.item;
  const relatedItems = useMemo(() => {
    if (!item) return [];
    return (related.data?.items || []).filter((entry) => entry.category === item.category && entry.slug !== item.slug).slice(0, 4);
  }, [item, related.data]);

  if (release.loading) {
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
                <button className="button button--telegram" type="button" onClick={() => onGetFiles(item)}><Icon name="telegram" size={20} /> Get all files on Telegram</button>
                <Link className="button button--ghost" to={`/browse/${item.category}`}>More {item.categoryLabel}</Link>
              </div>
              <p className="detail-layout__delivery-note"><Icon name="shield" size={15} /> No file is hosted on this website. Telegram delivers a copy from the private storage channel.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="detail-info page-width">
        <div className="detail-info__languages">
          <Eyebrow>AVAILABLE LABELS</Eyebrow>
          <h2>Language & <em>release details.</em></h2>
          <div className="language-tags">{item.languages.length ? item.languages.map((language) => <span key={language}><Icon name="check" size={14} /> {language}</span>) : <span><Icon name="check" size={14} /> Check Telegram delivery</span>}</div>
        </div>
        <div className="delivery-card">
          <span className="delivery-card__icon"><Icon name="telegram" size={22} /></span>
          <div><p className="eyebrow">HOW IT WORKS</p><h3>One link. Your private delivery.</h3></div>
          <p>Tap the delivery button, start the bot, and it copies the catalog files into your Telegram chat.</p>
          <button className="text-link" type="button" onClick={() => onGetFiles(item)}>Open delivery guide <Icon name="arrow" size={16} /></button>
        </div>
      </section>

      {item.fileChoices?.length ? <section className="file-choice-section page-width" aria-labelledby="file-choice-title">
        <div className="file-choice-section__heading">
          <div><Eyebrow>CHOOSE YOUR DELIVERY</Eyebrow><h2 id="file-choice-title">Pick a file or <em>quality.</em></h2><p>Every choice opens its own Telegram delivery link. Episode labels and quality tags are read from the uploaded file details.</p></div>
          <button className="button button--secondary" type="button" onClick={() => onGetFiles(item)}><Icon name="telegram" size={18} /> Get all {item.filesCount} files</button>
        </div>
        <div className="file-choice-list">
          {item.fileChoices.map((file) => {
            const heading = file.episode?.label || file.label || `Delivery file ${file.position}`;
            const hasDistinctLabel = file.episode?.label && file.label && file.label.toLowerCase() !== file.episode.label.toLowerCase();
            const episodeIndex = file.episode
              ? file.episode.start === file.episode.end
                ? `EP ${String(file.episode.start).padStart(2, '0')}`
                : `EP ${String(file.episode.start).padStart(2, '0')}–${String(file.episode.end).padStart(2, '0')}`
              : `FILE ${String(file.position).padStart(2, '0')}`;
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
              {file.deliveryReady ? <a className="file-choice__action" href={file.telegramUrl} target="_blank" rel="noreferrer" aria-label={`Get ${heading} on Telegram`}><Icon name="telegram" size={17} /> Get file</a> : <button className="file-choice__action" type="button" onClick={() => onGetFiles(item)} aria-label={`Open delivery for ${heading}`}><Icon name="telegram" size={17} /> Delivery</button>}
            </article>;
          })}
        </div>
      </section> : null}

      {item.episodeGroups?.length ? <section className="episode-section page-width" aria-labelledby="episode-guide-title">
        <div className="episode-section__heading">
          <div><Eyebrow>SMART EPISODE INDEX</Eyebrow><h2 id="episode-guide-title">Episode <em>guide.</em></h2></div>
          <span>{item.episodeCount || item.episodeGroups.length} indexed episode{(item.episodeCount || item.episodeGroups.length) === 1 ? '' : 's'}</span>
        </div>
        <div className="episode-grid">
          {item.episodeGroups.map((group) => <div className="episode-card" key={`${group.start}-${group.end}`}>
            <span className={`episode-card__number ${group.start === group.end ? '' : 'episode-card__number--range'}`}>{group.start === group.end ? `EP ${String(group.start).padStart(2, '0')}` : `${String(group.start).padStart(2, '0')}–${String(group.end).padStart(2, '0')}`}</span>
            <strong>{group.label}</strong>
            <small>{group.fileCount} delivery file{group.fileCount === 1 ? '' : 's'} included</small>
            <Icon name="telegram" size={15} />
          </div>)}
        </div>
        <p className="episode-section__note"><Icon name="spark" size={14} /> Built from the uploader’s cleaned caption first, with filename detection as a fallback. Choose an individual file above, or use the all-files delivery option.</p>
      </section> : null}

      {relatedItems.length ? <section className="catalog-section catalog-section--last page-width" aria-labelledby="related-title">
        <div className="section-heading"><div><Eyebrow>MORE IN {item.categoryLabel.toUpperCase()}</Eyebrow><h2 id="related-title">Keep the <em>queue going.</em></h2></div><Link className="text-link" to={`/browse/${item.category}`}>View collection <Icon name="arrow" size={16} /></Link></div>
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

  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage onGetFiles={setDeliveryItem} />} />
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/browse/:category" element={<BrowsePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/:category/:slug" element={<DetailPage onGetFiles={setDeliveryItem} />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      {deliveryItem ? <DeliveryDialog item={deliveryItem} onClose={() => setDeliveryItem(null)} /> : null}
    </>
  );
}
