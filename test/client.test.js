// -----------------------------------------------------------------------------
// The Caddy client against the real answers of Caddy v2.11 (test/fixtures/caddy,
// recorded on caddy:2 in Docker: two hosts on two traefik/whoami upstreams
// behind an active health check, one on a stopped upstream, an http:// site, a
// wildcard site), its errors, the configuration parsing and the certificate
// rules.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaddyClient, ERROR_KINDS, parseMetrics, portOf, sitesOf } from '../src/caddy/client.js';
import { DAY_MS, daysLeft, isExpiring, readable } from '../src/caddy/certificates.js';
import { normalizeConfig, parseServerUrl } from '../src/config.js';
import { BASE, FIXTURES, FakeCaddy, NOW, certificate } from './helpers/fakeCaddy.js';

const client = (caddy, extra = {}) =>
  new CaddyClient({ url: BASE, request: caddy.request, ...extra });

test('the real configuration of Caddy v2.11: one site per host, TLS, upstreams', () => {
  assert.deepEqual(sitesOf(FIXTURES.config), [
    { name: '*.wild.example.test', https: true, port: 443, upstreams: [] },
    { name: 'app.example.test', https: true, port: 443, upstreams: ['whoami1:80', 'whoami2:80'] },
    { name: 'broken.example.test', https: true, port: 443, upstreams: ['dead:80'] },
    { name: 'plain.example.test', https: false, port: null, upstreams: ['whoami1:80'] },
    { name: 'www.example.test', https: true, port: 443, upstreams: ['whoami1:80', 'whoami2:80'] },
  ]);
  assert.deepEqual(sitesOf(null), [], 'an empty Caddy answers null');
});

test('sites without host, nested subroutes, placeholders, explicit TLS and ports', () => {
  const sites = sitesOf({
    apps: {
      http: {
        servers: {
          a: {
            listen: [':8080'],
            routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'app:3000' }] }] }],
          },
          b: {
            listen: ['tcp/0.0.0.0:8443'],
            routes: [
              {
                handle: [
                  {
                    handler: 'subroute',
                    routes: [
                      {
                        match: [{ host: ['Deep.Example.test'] }],
                        handle: [
                          {
                            handler: 'reverse_proxy',
                            upstreams: [{ dial: '{http.request.host}:80' }, { dial: 'ok:1' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          c: {
            listen: [':80'],
            tls_connection_policies: [{}],
            routes: [
              { match: [{ host: ['{env.HOST}'] }], handle: [{ handler: 'static_response' }] },
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(sites, [
    { name: ':8080', https: true, port: 8080, upstreams: ['app:3000'] },
    { name: 'deep.example.test', https: true, port: 8443, upstreams: ['ok:1'] },
  ]);
  assert.equal(portOf('[::1]:2019'), 2019);
  assert.equal(portOf('unix//run/caddy.sock'), null);
});

test('the metrics: health of each upstream and the last configuration load', () => {
  const { healthy, reloadOk } = parseMetrics(FIXTURES.metrics);
  assert.deepEqual(Object.fromEntries(healthy), {
    'dead:80': false,
    'whoami1:80': true,
    'whoami2:80': true,
  });
  assert.equal(reloadOk, true);
  assert.deepEqual(parseMetrics('').reloadOk, null);
});

test('a snapshot: upstreams with their health from the metrics, or from the fails without', async () => {
  const caddy = new FakeCaddy();
  const snapshot = await client(caddy).snapshot();
  assert.deepEqual(
    snapshot.upstreams.map((u) => [u.address, u.healthy]),
    [
      ['whoami1:80', true],
      ['whoami2:80', true],
      ['dead:80', false],
    ],
  );
  assert.equal(snapshot.reloadOk, true);
  assert.ok(caddy.requests.every((r) => !r.headers.authorization));

  caddy.metricsAvailable = false;
  caddy.upstreams[0].fails = 3; // dead:80, passive health check
  const fallback = await client(caddy).snapshot();
  assert.deepEqual(
    fallback.upstreams.map((u) => [u.address, u.healthy]),
    [
      ['whoami1:80', true],
      ['whoami2:80', true],
      ['dead:80', false],
    ],
  );
  assert.equal(fallback.reloadOk, null);
});

test('the errors, by kind; GET only', async () => {
  const caddy = new FakeCaddy({ auth: 'gladys:s3cret' });
  await assert.rejects(client(caddy).snapshot(), { kind: ERROR_KINDS.AUTH });
  const ok = await client(caddy, { username: 'gladys', password: 's3cret' }).snapshot();
  assert.equal(ok.sites.length, 5);
  for (const [failure, kind] of [
    ['down', ERROR_KINDS.UNREACHABLE],
    [403, ERROR_KINDS.FORBIDDEN],
    [404, ERROR_KINDS.NOT_CADDY],
    [308, ERROR_KINDS.REDIRECT],
    [500, ERROR_KINDS.HTTP],
  ]) {
    caddy.failure = failure;
    await assert.rejects(client(caddy).snapshot(), { kind }, String(failure));
  }
  const html = new CaddyClient({
    url: BASE,
    request: async () => ({ status: 200, body: '<html></html>' }),
  });
  await assert.rejects(html.snapshot(), { kind: ERROR_KINDS.NOT_CADDY });
  const tls = new CaddyClient({
    url: BASE,
    request: async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      });
    },
  });
  await assert.rejects(tls.snapshot(), { kind: ERROR_KINDS.TLS });
});

test('the address typed by the user', () => {
  assert.equal(parseServerUrl('192.0.2.10'), 'http://192.0.2.10:2019');
  assert.equal(parseServerUrl('192.0.2.10:2020'), 'http://192.0.2.10:2020');
  assert.equal(parseServerUrl('http://192.0.2.10:2019/config/'), 'http://192.0.2.10:2019');
  assert.equal(
    parseServerUrl('https://caddy.example.test/admin/'),
    'https://caddy.example.test/admin',
  );
  assert.equal(parseServerUrl('http://user:pw@192.0.2.10:2019'), null);
  assert.equal(parseServerUrl('ftp://192.0.2.10'), null);
  const config = normalizeConfig({ url: '192.0.2.10', expiry_days: 500 });
  assert.equal(config.certificateHost, '192.0.2.10');
  assert.equal(config.expiryDays, 14);
  assert.equal(config.pollIntervalMs, 60_000);
  assert.equal(config.language, 'fr');
  assert.equal(
    normalizeConfig({ url: 'x', certificate_host: ' 198.51.100.7 ' }).certificateHost,
    '198.51.100.7',
  );
  assert.equal(
    normalizeConfig({ url: 'http://[2001:db8::1]:2019' }).certificateHost,
    '2001:db8::1',
  );
  assert.equal(normalizeConfig({ url: '  ' }).url, '');
  assert.equal(normalizeConfig({ url: 'http://' }).url, null);
});

test('which certificates are read', () => {
  const site = (name, https = true) => ({ name, https, upstreams: [] });
  assert.equal(readable(site('app.example.test')), true);
  assert.equal(readable(site('app.example.test', false)), false);
  for (const name of ['*.wild.example.test', 'localhost', '192.0.2.10', ':8080', '::1']) {
    assert.equal(readable(site(name)), false, name);
  }
});

test('a certificate is expiring under the threshold, and only when its renewal is late', () => {
  assert.equal(daysLeft(certificate(60), NOW), 60);
  assert.equal(daysLeft(certificate(-2), NOW), -2);
  assert.equal(isExpiring(certificate(60), NOW, 14), false);
  assert.equal(isExpiring(certificate(13), NOW, 14), true, '90-day certificate, 13 days left');
  assert.equal(isExpiring(certificate(20), NOW, 30), false, 'Caddy renews at 30 days left');
  assert.equal(isExpiring(certificate(-1), NOW, 1), true, 'expired');
  // `tls internal`: a 12-hour certificate is always under the threshold.
  const internal = { notBefore: NOW - 3 * 3600_000, notAfter: NOW + 9 * 3600_000 };
  assert.equal(isExpiring(internal, NOW, 14), false);
  assert.equal(isExpiring({ ...internal, notAfter: NOW + 3600_000 }, NOW, 14), false);
  assert.equal(
    isExpiring({ notBefore: NOW - 11 * 3600_000, notAfter: NOW + 1800_000 }, NOW, 14),
    true,
  );
  assert.equal(DAY_MS, 86_400_000);
});
