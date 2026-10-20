// -----------------------------------------------------------------------------
// An in-memory Caddy: /config/, /reverse_proxy/upstreams and /metrics, starting
// from the real answers of Caddy v2.11 (test/fixtures/caddy), and the
// certificates its sites serve — with the helpers the tests need to break
// things the way the Docker test did: an upstream down, a site removed, a
// certificate about to expire, the API down or behind basic auth.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { DAY_MS } from '../../src/caddy/certificates.js';

export const BASE = 'http://192.0.2.10:2019';
export const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);

const read = (name) => readFileSync(new URL(`../fixtures/caddy/${name}`, import.meta.url), 'utf8');

export const FIXTURES = {
  config: JSON.parse(read('v2.11-config.json')),
  upstreams: JSON.parse(read('v2.11-upstreams.json')),
  metrics: read('v2.11-metrics.txt'),
};

const HEALTHY_LINE = /^caddy_reverse_proxy_upstreams_healthy\{upstream="([^"]*)"\} (\d)$/;

/** A certificate valid `days` more days (90-day lifetime, as Let's Encrypt). */
export const certificate = (days, { now = NOW, lifetimeDays = 90, issuer = 'R11' } = {}) => ({
  notBefore: now + (days - lifetimeDays) * DAY_MS,
  notAfter: now + days * DAY_MS,
  issuer,
});

export class FakeCaddy {
  constructor({ config = FIXTURES.config, auth = null } = {}) {
    this.config = structuredClone(config);
    this.upstreams = structuredClone(FIXTURES.upstreams);
    /** Health of each upstream, as caddy_reverse_proxy_upstreams_healthy says. */
    this.healthy = new Map();
    for (const line of FIXTURES.metrics.split('\n')) {
      const match = line.match(HEALTHY_LINE);
      if (match) {
        this.healthy.set(match[1], match[2] === '1');
      }
    }
    this.reloadOk = true;
    this.metricsAvailable = true;
    /** Certificates by SNI name, or an error code. */
    this.certificates = new Map(
      ['app.example.test', 'www.example.test', 'broken.example.test'].map((name) => [
        name,
        certificate(60),
      ]),
    );
    /** 'user:password' required in basic auth, or null. */
    this.auth = auth;
    /** 'down': the server does not answer; a number: that HTTP status. */
    this.failure = null;
    this.requests = [];
    this.probes = [];
  }

  setHealthy(address, healthy) {
    this.healthy.set(address, healthy);
  }

  /** Remove the site block of a host (the route that matches it). */
  removeSite(host) {
    for (const server of Object.values(this.config.apps.http.servers)) {
      server.routes = server.routes.filter((route) => !route.match?.[0]?.host?.includes(host));
    }
  }

  metrics() {
    const lines = FIXTURES.metrics
      .split('\n')
      .filter((line) => !HEALTHY_LINE.test(line))
      .map((line) =>
        line.startsWith('caddy_config_last_reload_successful ')
          ? `caddy_config_last_reload_successful ${this.reloadOk ? 1 : 0}`
          : line,
      );
    for (const [address, healthy] of this.healthy) {
      lines.push(`caddy_reverse_proxy_upstreams_healthy{upstream="${address}"} ${healthy ? 1 : 0}`);
    }
    return lines.join('\n');
  }

  /** The request seam of src/caddy/client.js. */
  request = async (url, { headers = {} } = {}) => {
    this.requests.push({ url, headers });
    if (this.failure === 'down') {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    }
    if (typeof this.failure === 'number') {
      return { status: this.failure, body: '' };
    }
    if (this.auth) {
      const expected = `Basic ${Buffer.from(this.auth).toString('base64')}`;
      if (headers.authorization !== expected) {
        return { status: 401, body: '' };
      }
    }
    const path = url.slice(BASE.length);
    if (path === '/config/') {
      return { status: 200, body: `${JSON.stringify(this.config)}\n` };
    }
    if (path === '/reverse_proxy/upstreams') {
      return { status: 200, body: `${JSON.stringify(this.upstreams)}\n` };
    }
    if (path === '/metrics' && this.metricsAvailable) {
      return { status: 200, body: this.metrics() };
    }
    return { status: 404, body: '{"error":"not found"}\n' };
  };

  /** The TLS seam of src/caddy/certificates.js. */
  probe = async ({ host, port, servername }) => {
    this.probes.push({ host, port, servername });
    if (this.failure === 'down') {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    const found = this.certificates.get(servername);
    if (!found) {
      throw Object.assign(new Error('alert internal error'), {
        code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
      });
    }
    if (typeof found === 'string') {
      throw Object.assign(new Error(found), { code: found });
    }
    return { ...found };
  };
}
