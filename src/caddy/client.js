// -----------------------------------------------------------------------------
// Caddy client: the admin API of Caddy 2 (port 2019 by default), read only.
//
//   GET /config/                  the running configuration (JSON, `null` when
//                                 empty): the HTTP servers, their listen
//                                 addresses and routes, host matchers and
//                                 reverse_proxy handlers with their upstreams
//   GET /reverse_proxy/upstreams  every upstream of every reverse_proxy:
//                                 address, requests in flight, recent fails
//   GET /metrics                  Prometheus metrics, among them
//                                 caddy_reverse_proxy_upstreams_healthy (1/0
//                                 per upstream, from the health checks) and
//                                 caddy_config_last_reload_successful
//
// Caddy has no endpoint for its version. The admin API can change the whole
// configuration: this client only ever sends GET requests.
//
// Redirects are not followed: the basic auth credentials (a read-only site of
// the user in front of the API) would be sent to wherever the address points.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate of the API address does not verify
  AUTH: 'auth', // basic auth refused (or missing)
  FORBIDDEN: 'forbidden', // 403: the Host is not in the `origins` of the admin API
  NOT_CADDY: 'not_caddy', // something answers, not the admin API of Caddy
  REDIRECT: 'redirect', // the address redirects (usually HTTP to HTTPS)
  HTTP: 'http', // any other HTTP error
});

export class CaddyError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CaddyError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// A large configuration (hundreds of sites) stays well under this.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * The one function that talks to the admin API. The client takes it as a
 * parameter: the tests replace it with an in-memory Caddy
 * (test/helpers/fakeCaddy.js).
 *
 * node:http, not fetch: fetch always sends `Sec-Fetch-Mode`, and the admin API
 * of Caddy then enforces its origin check and answers 403 to any client that
 * is not a browser on an allowed origin.
 * @returns {Promise<{ status: number, body: string }>}
 */
export function httpRequest(url, { headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, { headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          response.destroy(new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    request.on('timeout', () =>
      request.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })),
    );
    request.on('error', reject);
  });
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => (Array.isArray(value) ? value : []);

// A placeholder (`{http.request.host}`, `{env.APP}`) is only known per request.
const hasPlaceholder = (text) => /[{}]/.test(text);

/** The port of a listen address: `:443`, `0.0.0.0:443`, `tcp/:8443-8444`. */
export function portOf(listen) {
  const match = typeof listen === 'string' ? listen.match(/:(\d+)(?:-\d+)?$/) : null;
  return match ? Number(match[1]) : null;
}

/**
 * Whether a server serves TLS: explicit connection policies, or automatic
 * HTTPS — which Caddy applies to every server not listening on the HTTP port
 * only, unless disabled.
 */
function servesTls(server, httpPort) {
  if (Array.isArray(server.tls_connection_policies)) {
    return true;
  }
  if (server.automatic_https?.disable === true) {
    return false;
  }
  const ports = list(server.listen).map(portOf).filter(Boolean);
  return ports.length > 0 && ports.some((port) => port !== httpPort);
}

/** The listen port a TLS server is reached on (443 first). */
function tlsPortOf(server, httpPort) {
  const ports = list(server.listen)
    .map(portOf)
    .filter((port) => port && port !== httpPort);
  return ports.includes(443) ? 443 : (ports[0] ?? 443);
}

/**
 * Walk the routes of a server: the hosts each route matches (inherited by its
 * subroutes) and the upstreams of the reverse_proxy handlers below them.
 * @param {object[]} routes
 * @param {string[]} hosts the hosts matched by the enclosing routes
 * @param {(host: string, dials: string[]) => void} visit
 */
function walkRoutes(routes, hosts, visit) {
  for (const route of list(routes)) {
    const matched = list(route?.match).flatMap((matcher) => list(matcher?.host));
    const own = matched
      .filter((host) => typeof host === 'string' && host && !hasPlaceholder(host))
      .map((host) => host.toLowerCase());
    if (matched.length > 0 && own.length === 0) {
      continue; // hosts only known per request (placeholders)
    }
    const scope = own.length > 0 ? [...new Set(own)] : hosts;
    // A route without host that only wraps subroutes is not a site by itself.
    const content = list(route?.handle).some((handler) => handler?.handler !== 'subroute');
    if (own.length > 0 || content) {
      for (const host of scope) {
        visit(host, []);
      }
    }
    for (const handler of list(route?.handle)) {
      if (handler?.handler === 'subroute') {
        walkRoutes(handler.routes, scope, visit);
      } else if (handler?.handler === 'reverse_proxy') {
        const dials = list(handler.upstreams)
          .map((upstream) => upstream?.dial)
          .filter((dial) => typeof dial === 'string' && dial && !hasPlaceholder(dial));
        for (const host of scope) {
          visit(host, dials);
        }
      }
    }
  }
}

/**
 * The sites of the configuration of Caddy, one per host name (a site block
 * `a.example.com, b.example.com` gives two), or per listen address for a
 * site without host (`:8080`).
 * @returns {{ name: string, https: boolean, port: number|null, upstreams: string[] }[]}
 */
export function sitesOf(config) {
  const http = object(object(object(config).apps).http);
  const httpPort = Number.isInteger(http.http_port) ? http.http_port : 80;
  const sites = new Map();
  for (const server of Object.values(object(http.servers))) {
    if (!server || typeof server !== 'object') {
      continue;
    }
    const https = servesTls(server, httpPort);
    // Hosts served in plain HTTP on a TLS port (`http://app.lan:8080`).
    const skip = new Set(
      list(server.automatic_https?.skip)
        .filter((host) => typeof host === 'string')
        .map((host) => host.toLowerCase()),
    );
    const port = https ? tlsPortOf(server, httpPort) : null;
    // A route without host matcher answers any host on this listen address:
    // a site of its own (`:8080 { … }`), unless the server has sites with a
    // host, where it is only the fallback (a 404 after the sites).
    const withHosts = list(server.routes).some((route) =>
      list(route?.match).some((matcher) => list(matcher?.host).length > 0),
    );
    const anyHost = withHosts
      ? ''
      : list(server.listen)
          .filter((listen) => typeof listen === 'string')
          .join(' ');
    walkRoutes(server.routes, anyHost ? [anyHost] : [], (name, dials) => {
      let site = sites.get(name);
      if (!site) {
        const tls = https && !skip.has(name);
        site = { name, https: tls, port: tls ? port : null, upstreams: [] };
        sites.set(name, site);
      }
      for (const dial of dials) {
        if (!site.upstreams.includes(dial)) {
          site.upstreams.push(dial);
        }
      }
    });
  }
  return [...sites.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The answer of /reverse_proxy/upstreams, normalized. */
export function normalizeUpstreams(data) {
  return list(data)
    .filter((entry) => typeof entry?.address === 'string' && entry.address)
    .map((entry) => ({
      address: entry.address,
      requests: Number.isFinite(entry.num_requests) ? entry.num_requests : 0,
      fails: Number.isFinite(entry.fails) ? entry.fails : 0,
    }));
}

const unescapeLabel = (text) => text.replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * The few metrics the integration reads.
 * @returns {{ healthy: Map<string, boolean>, reloadOk: boolean|null }}
 */
export function parseMetrics(text) {
  const healthy = new Map();
  let reloadOk = null;
  for (const line of String(text ?? '').split('\n')) {
    const upstream = line.match(
      /^caddy_reverse_proxy_upstreams_healthy\{upstream="((?:[^"\\]|\\.)*)"\}\s+(\S+)/,
    );
    if (upstream) {
      healthy.set(unescapeLabel(upstream[1]), Number(upstream[2]) === 1);
      continue;
    }
    const reload = line.match(/^caddy_config_last_reload_successful(?:\{\})?\s+(\S+)/);
    if (reload) {
      reloadOk = Number(reload[1]) === 1;
    }
  }
  return { healthy, reloadOk };
}

export class CaddyClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, `http(s)://host[:port][/path]`
   * @param {string} [options.username] basic auth, when a site of the user serves the API
   * @param {string} [options.password]
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   * @param {(message: string) => void} [options.debug] where the optional reads report
   */
  constructor({
    url,
    username = '',
    password = '',
    request = httpRequest,
    timeoutMs = 10_000,
    debug = () => {},
  }) {
    this.url = url;
    this.headers = {};
    if (username) {
      const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      this.headers.authorization = `Basic ${token}`;
    }
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.debug = debug;
  }

  /** @returns {Promise<string>} the body of a 2xx answer */
  async fetchText(path) {
    let response;
    try {
      response = await this.request(`${this.url}${path}`, {
        headers: this.headers,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      const code = err.cause?.code ?? err.code;
      if (err.message === 'Response too large') {
        throw new CaddyError(ERROR_KINDS.HTTP, 'Response too large');
      }
      if (TLS_CODES.has(code)) {
        throw new CaddyError(ERROR_KINDS.TLS, `Certificate refused (${code})`);
      }
      throw new CaddyError(ERROR_KINDS.UNREACHABLE, code ?? err.name ?? err.message);
    }
    const { status } = response;
    if (status === 401) {
      throw new CaddyError(ERROR_KINDS.AUTH, `Credentials refused (HTTP ${status})`, { status });
    }
    if (status === 403) {
      throw new CaddyError(ERROR_KINDS.FORBIDDEN, `Forbidden (HTTP 403)`, { status });
    }
    if (status >= 300 && status < 400) {
      throw new CaddyError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if (status === 404) {
      throw new CaddyError(ERROR_KINDS.NOT_CADDY, `${path} not found (HTTP 404)`, { status });
    }
    if (status < 200 || status >= 300) {
      throw new CaddyError(ERROR_KINDS.HTTP, `Unexpected answer (HTTP ${status})`, { status });
    }
    return response.body;
  }

  async fetchJson(path) {
    const body = await this.fetchText(path);
    try {
      return JSON.parse(body);
    } catch {
      throw new CaddyError(ERROR_KINDS.NOT_CADDY, `The answer of ${path} is not JSON`);
    }
  }

  /** An optional read: its failure is not the failure of Caddy. */
  async optional(path, read) {
    try {
      return await read(path);
    } catch (err) {
      this.debug(`${path} not read: ${err.message}`);
      return null;
    }
  }

  /**
   * One read of Caddy.
   * @returns {Promise<{ sites: object[], upstreams: object[], reloadOk: boolean|null }>}
   *   upstreams: every upstream the sites proxy to, with `healthy` from the
   *   health checks (metrics) or, without metrics, from the recent fails.
   * @throws {CaddyError}
   */
  async snapshot() {
    const config = await this.fetchJson('/config/');
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
      throw new CaddyError(ERROR_KINDS.NOT_CADDY, 'The answer of /config/ is not a Caddy config');
    }
    const sites = sitesOf(config);
    const dials = [...new Set(sites.flatMap((site) => site.upstreams))];
    const [raw, metrics] =
      dials.length > 0
        ? await Promise.all([
            this.optional('/reverse_proxy/upstreams', (path) => this.fetchJson(path)),
            this.optional('/metrics', (path) => this.fetchText(path)),
          ])
        : [null, await this.optional('/metrics', (path) => this.fetchText(path))];
    const { healthy, reloadOk } = parseMetrics(metrics);
    // Without metrics this time, after they once answered: the health is
    // unknown, not "fails === 0" (0 for an upstream down by active checks).
    const unknown = metrics === null && this.metricsSeen;
    this.metricsSeen ||= metrics !== null;
    const known = new Map(normalizeUpstreams(raw).map((entry) => [entry.address, entry]));
    const upstreams = dials.map((address) => {
      const entry = known.get(address) ?? { requests: 0, fails: 0 };
      return {
        address,
        requests: entry.requests,
        fails: entry.fails,
        healthy: healthy.get(address) ?? (unknown ? null : entry.fails === 0),
      };
    });
    return { sites, upstreams, reloadOk };
  }
}
