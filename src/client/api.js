const API_ROOT = '/api';

async function request(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = new Error(body?.error || 'Unable to load the catalog right now.');
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function getConfig() {
  return request('/config');
}

/**
 * A catalog listing, one page at a time.
 *
 * The server answers with `{ items, total, page, limit, pages, hasMore }`: `total` is the size of
 * the whole shelf and `items` is the part of it this visitor has reached, so a category is never
 * silently truncated at some fixed number of cards.
 */
export async function getContent({ category, query, genre, page = 1, limit = 60 } = {}) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (query) params.set('q', query);
  if (genre) params.set('genre', genre);
  if (page > 1) params.set('page', page);
  if (limit) params.set('limit', limit);
  const suffix = params.size ? `?${params}` : '';
  return request(`/content${suffix}`);
}

/** Every category with the number of releases actually in it, counted in the store. */
export async function getCategories() {
  return request('/categories');
}

/** The genre shelves the menu offers, 18+ never among them. */
export async function getGenres() {
  return request('/genres');
}

export async function getFeatured() {
  return request('/content/featured');
}

export async function confirmAdultAccess() {
  return request('/adult-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true })
  });
}

export async function getContentBySlug(slug) {
  return request(`/content/${encodeURIComponent(slug)}`);
}
