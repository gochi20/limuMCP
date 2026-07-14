const DEFAULT_PORTAL_BASE_URL = 'https://portal.limu.co.mw';

export const LIMU_OAUTH_SCOPES = Object.freeze([
  'profile:read',
  'clients:read',
  'clients:write',
  'cargo:read',
  'packages:read',
  'shipments:read',
  'budgets:read',
  'budgets:write',
  'requisitions:read',
  'requisitions:review',
  'requisitions:delete',
  'payment_vouchers:read',
  'payment_vouchers:review',
  'payment_vouchers:pay',
  'payment_vouchers:delete',
  'leave:read',
  'leave:review',
  'offline_access',
]);

export function portalBaseUrl() {
  return (process.env.LIMU_PORTAL_BASE_URL || DEFAULT_PORTAL_BASE_URL).replace(/\/+$/, '');
}

export function limuOAuthIssuer() {
  return `${portalBaseUrl()}/Api/v1/oauth`;
}

export function mcpResourceUrl(requestOrUrl) {
  const source = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.url;
  const url = new URL(source);
  return new URL('/api/mcp', url.origin).href;
}

export function tokenFromAuthInfo(authInfo) {
  const token = authInfo?.token || '';
  if (!token) {
    throw new Error('OAuth bearer token is required.');
  }
  return token;
}

export async function portalRequest(path, options = {}) {
  const {
    token,
    method = 'GET',
    query,
    body,
    signal,
  } = options;
  const url = new URL(`${portalBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    Accept: 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error_description || payload?.error || `Portal API returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export function jsonToolResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export async function verifyLimuToken(token, expectedResource) {
  if (!token) {
    return undefined;
  }

  try {
    const user = await portalRequest('/Api/v1/oauth/userinfo/', { token });
    if (!expectedResource || user.aud !== expectedResource) {
      return undefined;
    }
    const scopes = typeof user.scope === 'string'
      ? user.scope.split(/\s+/).filter(Boolean)
      : [];
    const expiresAt = Date.parse(user.expires_at || '');

    return {
      token,
      scopes,
      clientId: String(user.sub || user.id || user.email || 'limu-user'),
      ...(Number.isNaN(expiresAt) ? {} : { expiresAt: Math.floor(expiresAt / 1000) }),
      extra: {
        user,
      },
    };
  } catch {
    return undefined;
  }
}
