// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Caddy server: the address of its admin API (port 2019, or a read-only
// site of the user in front of it, optionally behind basic auth), the host the
// certificates are read from (the same machine by default), how often Caddy is
// read, and how many days before its expiry a certificate is announced.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  url: '',
  username: '',
  password: '',
  certificate_host: '',
  poll_interval: '60',
  expiry_days: 14,
  language: 'fr',
};

export const MIN_EXPIRY_DAYS = 1;
export const MAX_EXPIRY_DAYS = 60;

export const ADMIN_PORT = 2019;

// A URL copied from the browser may point at an endpoint of the admin API: the
// API lives at the root of the same address.
const ENDPOINT_PATH = /\/(config|reverse_proxy|metrics|pki)(\/.*)?$/i;

/**
 * Parse the address typed by the user into a base URL: a bare host or IP
 * (`192.0.2.10`, port 2019 then), `192.0.2.10:2020`, or a URL
 * (`http://192.0.2.10:2019/config/`). HTTP by default for a bare host. A path
 * is kept (an API behind a sub-path), the endpoints of the API dropped.
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port][/path]`, null when unusable
 */
export function parseServerUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs: they have their fields.
  if (url.username || url.password) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(ADMIN_PORT); // a bare host: the default admin port
  }
  const path = url.pathname.replace(ENDPOINT_PATH, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * The host the certificates are read from: typed by the user (a host name or
 * an IP, without port), or the host of the API address.
 * @returns {string|null}
 */
export function parseHost(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  try {
    const url = new URL(`https://${raw.trim()}`);
    return url.hostname && !url.port && url.pathname === '/' ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Host part shown to the user (no scheme). */
export const hostOf = (url) => url.replace(/^https?:\/\//, '');

const bracketless = (host) => host.replace(/^\[(.*)\]$/, '$1');

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const typed = text('url');
  const url = typed ? parseServerUrl(typed) : '';
  const pollInterval = POLL_INTERVALS.includes(String(source.poll_interval))
    ? String(source.poll_interval)
    : DEFAULT_CONFIG.poll_interval;
  const days = Number(source.expiry_days);
  const certificateHost =
    parseHost(text('certificate_host')) ?? (url ? bracketless(new URL(url).hostname) : '');
  return {
    // '' when nothing was typed yet, null when what was typed is unusable.
    url,
    username: text('username'),
    // A password may legitimately start or end with a space: kept as typed.
    password: typeof source.password === 'string' ? source.password : '',
    certificateHost: bracketless(certificateHost),
    pollIntervalMs: Number(pollInterval) * 1000,
    expiryDays:
      Number.isInteger(days) && days >= MIN_EXPIRY_DAYS && days <= MAX_EXPIRY_DAYS
        ? days
        : DEFAULT_CONFIG.expiry_days,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
