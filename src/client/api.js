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

export async function getContent({ category, query } = {}) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (query) params.set('q', query);
  const suffix = params.size ? `?${params}` : '';
  return request(`/content${suffix}`);
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
