// -----------------------------------------------------------------------------
// The hub against the SDK's fake Gladys and a fake Caddy: discovery, states,
// transitions and scene events, certificates, persistence across restarts,
// errors, quiet logs, the widget, the scene actions and the reading timer of
// the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { DAY_MS } from '../src/caddy/certificates.js';
import { SERVER_KEYS, SITE_KEYS, serverIds } from '../src/devices.js';
import { TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import {
  BASE,
  FakeCaddy,
  certificate,
  confirm,
  createClock,
  createDevices,
  createWorld,
  idsOf,
} from './helpers/world.js';

const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const serverState = (world, key) => world.fake.lastState(serverIds(world.gladys).feature(key));
const siteState = (world, name, key) => world.fake.lastState(idsOf(world, name).feature(key));

test('the server and one device per site in Discovery, nothing polled by Gladys', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Caddy', 'app.example.test', 'broken.example.test', 'plain.example.test', 'www.example.test'],
    'the wildcard site has nothing to show: no certificate read, no upstream',
  );
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  assert.deepEqual(devices[1].params, [{ name: 'PORT', value: '443' }]);
  assert.deepEqual(
    devices[3].features.map((f) => f.external_id.split(':').pop()),
    ['upstreams_healthy', 'upstreams_total'],
    'an http:// site has no certificate',
  );
  assert.equal(world.fake.states.length, 0, 'nothing published for devices not added');
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.sceneEvents.length, 0, 'the upstream already down is not news');
  assert.deepEqual(world.caddy.probes.map((p) => [p.host, p.port, p.servername]).sort(), [
    ['192.0.2.10', 443, 'app.example.test'],
    ['192.0.2.10', 443, 'broken.example.test'],
    ['192.0.2.10', 443, 'www.example.test'],
  ]);
  assert.ok(world.caddy.requests.every((r) => r.url.startsWith(BASE)));
});

test('the states of the added devices at once, then only the changes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.equal(serverState(world, SERVER_KEYS.REACHABLE), 1);
  assert.equal(serverState(world, SERVER_KEYS.CONFIG_OK), 1);
  assert.equal(serverState(world, SERVER_KEYS.SITES), 5);
  assert.equal(serverState(world, SERVER_KEYS.UPSTREAMS_DOWN), 1);
  assert.equal(serverState(world, SERVER_KEYS.CERTIFICATES_EXPIRING), 0);
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.CERTIFICATE_DAYS), 60);
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.UPSTREAMS_HEALTHY), 2);
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.UPSTREAMS_TOTAL), 2);
  assert.equal(siteState(world, 'broken.example.test', SITE_KEYS.UPSTREAMS_HEALTHY), 0);
  assert.deepEqual([...new Set(world.fake.transports.map((e) => e.transport))], ['local']);

  const before = world.fake.states.length;
  await world.hub.pollNow();
  assert.equal(world.fake.states.length, before, 'nothing changed, nothing sent');
  assert.equal(world.caddy.probes.length, 3, 'certificates read once an hour, not every minute');

  world.caddy.reloadOk = false;
  await world.hub.pollNow();
  assert.equal(serverState(world, SERVER_KEYS.CONFIG_OK), 0);
});

test('an upstream down, confirmed on two reads, then back up with the outage length', async (t) => {
  const clock = createClock();
  const world = await createWorld({ clock });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.caddy.setHealthy('whoami2:80', false);
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.UPSTREAM_DOWN).length, 0, 'one read is not enough');
  await world.hub.pollNow();
  assert.deepEqual(events(world, TRIGGERS.UPSTREAM_DOWN)[0].data, {
    upstream: 'whoami2:80',
    sites: 'app.example.test, www.example.test',
    fails: 0,
  });
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.UPSTREAMS_HEALTHY), 1);
  assert.equal(serverState(world, SERVER_KEYS.UPSTREAMS_DOWN), 2);
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.UPSTREAM_DOWN).length, 1, 'announced once');

  clock.advance(12 * 60_000);
  world.caddy.setHealthy('whoami2:80', true);
  await confirm(world);
  const up = events(world, TRIGGERS.UPSTREAM_UP);
  assert.equal(up.length, 1);
  assert.equal(up[0].data.downtime_minutes, 12);
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.UPSTREAMS_HEALTHY), 2);
});

test('a health flapping for one read fires nothing', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  // A restarted Caddy reports every upstream healthy until its first check.
  world.caddy.setHealthy('dead:80', true);
  await world.hub.pollNow();
  world.caddy.setHealthy('dead:80', false);
  await world.hub.pollNow();
  world.caddy.setHealthy('whoami1:80', false);
  await world.hub.pollNow();
  world.caddy.setHealthy('whoami1:80', true);
  await confirm(world);
  assert.deepEqual(world.fake.sceneEvents, []);
});

test('a new upstream that appears down is announced, a removed one is forgotten', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const routes = world.caddy.config.apps.http.servers.srv0.routes;
  routes.push({
    match: [{ host: ['new.example.test'] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'new:80' }, { dial: 'fine:80' }] }],
  });
  world.caddy.setHealthy('new:80', false);
  await world.hub.pollNow();
  assert.deepEqual(
    events(world, TRIGGERS.UPSTREAM_DOWN).map((e) => e.data.upstream),
    ['new:80'],
  );
  assert.ok(world.fake.discoveredDevices.some((d) => d.name === 'new.example.test'));
  routes.pop();
  await confirm(world);
  assert.equal(world.hub.saved.upstreams['new:80'], undefined);
  assert.equal(world.hub.upstreams.has('new:80'), false);
});

test('a site removed from the configuration: missing if added to Gladys, gone otherwise', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world, (d) => d.name === 'broken.example.test');
  world.caddy.removeSite('broken.example.test');
  world.caddy.removeSite('plain.example.test');
  await world.hub.pollNow();
  assert.equal(world.hub.find(idsOf(world, 'broken.example.test').device).present, true);
  await world.hub.pollNow();
  const broken = world.hub.find(idsOf(world, 'broken.example.test').device);
  assert.equal(broken.present, false);
  assert.equal(world.hub.stateOf(broken), 'missing');
  assert.equal(siteState(world, 'broken.example.test', SITE_KEYS.UPSTREAMS_TOTAL), 0);
  assert.equal(world.hub.sites.has('plain.example.test'), false);
  assert.ok(!world.fake.discoveredDevices.some((d) => d.name === 'broken.example.test'));
});

test('a certificate late for renewal is announced once, again after a renewal that fails', async (t) => {
  const clock = createClock();
  const world = await createWorld({
    clock,
    config: { url: BASE, language: 'fr', expiry_days: 10 },
  });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.caddy.certificates.set('app.example.test', certificate(12));
  clock.advance(3600_000);
  await world.hub.pollNow();
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.CERTIFICATE_DAYS), 11);
  assert.equal(events(world, TRIGGERS.CERTIFICATE_EXPIRING).length, 0, '11 days > 10');

  clock.advance(2 * DAY_MS);
  await world.hub.pollNow();
  const [event] = events(world, TRIGGERS.CERTIFICATE_EXPIRING);
  assert.deepEqual(event.data, {
    device: idsOf(world, 'app.example.test').device,
    site: 'app.example.test',
    days_left: 9,
    expires_at: '2026-11-01',
    issuer: 'R11',
  });
  assert.equal(serverState(world, SERVER_KEYS.CERTIFICATES_EXPIRING), 1);
  clock.advance(DAY_MS);
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.CERTIFICATE_EXPIRING).length, 1, 'once per certificate');

  // Renewed for a few days only (a renewal that does not go through).
  world.caddy.certificates.set(
    'app.example.test',
    certificate(2, { now: clock.time, lifetimeDays: 12 }),
  );
  await world.hub.pollNow({ certificates: true });
  assert.equal(events(world, TRIGGERS.CERTIFICATE_EXPIRING).length, 2);
  world.caddy.certificates.set('app.example.test', certificate(90, { now: clock.time }));
  await world.hub.pollNow({ certificates: true });
  assert.equal(serverState(world, SERVER_KEYS.CERTIFICATES_EXPIRING), 0);
  assert.deepEqual(world.hub.saved.certificates, {});
});

test('a certificate that cannot be read keeps its last date and is retried sooner', async (t) => {
  const clock = createClock();
  const world = await createWorld({ clock });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.caddy.certificates.set('app.example.test', 'ECONNRESET');
  await world.hub.pollNow({ certificates: true });
  assert.equal(world.hub.certificates.get('app.example.test').error, 'ECONNRESET');
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.CERTIFICATE_DAYS), 60);
  const probes = world.caddy.probes.length;
  clock.advance(5 * 60_000);
  await world.hub.pollNow();
  assert.equal(world.caddy.probes.length, probes + 1, 'only the failed one, after 5 minutes');
});

test('Caddy unreachable: one failed read is tolerated, the second fires once', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.caddy.failure = 'down';
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.UNREACHABLE).length, 0);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(serverState(world, SERVER_KEYS.REACHABLE), 1);
  await world.hub.pollNow();
  await world.hub.pollNow();
  assert.deepEqual(
    events(world, TRIGGERS.UNREACHABLE).map((e) => e.data),
    [{ error: 'Caddy does not answer' }],
  );
  assert.equal(serverState(world, SERVER_KEYS.REACHABLE), 0);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  assert.equal(events(world, TRIGGERS.UPSTREAM_DOWN).length, 0, 'no upstream event for that');

  world.caddy.failure = null;
  await world.hub.pollNow();
  assert.equal(serverState(world, SERVER_KEYS.REACHABLE), 1);
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('a restart keeps the last states: a change during it is announced once', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  const caddy = new FakeCaddy();
  caddy.setHealthy('whoami1:80', false);
  const second = await createWorld({ caddy, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.equal(events(second, TRIGGERS.UPSTREAM_DOWN).length, 0, 'confirmed at the second read');
  await second.hub.pollNow();
  assert.equal(events(second, TRIGGERS.UPSTREAM_DOWN).length, 1);
  await second.hub.store.flush();
  const third = await createWorld({ caddy, dataDir: first.dataDir });
  t.after(() => third.app.stop());
  await third.hub.pollNow();
  assert.equal(third.fake.sceneEvents.length, 0, 'nothing new after a second restart');
});

test('another Caddy address starts afresh: the devices of the old one leave Discovery', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await world.fake.configUpdated({ url: 'http://192.0.2.10:2019/config/', language: 'en' });
  assert.equal(world.fake.connectionStatus.connected, true, 'same address');
  await world.fake.configUpdated({ url: 'http://198.51.100.7:2019', language: 'en' });
  assert.equal(world.fake.connectionStatus.connected, false, 'nothing answers there');
  assert.deepEqual(world.fake.discoveredDevices, []);
});

test('configuration missing: a readable status, no request', async (t) => {
  const world = await createWorld({ config: { language: 'fr' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /Saisissez l'adresse/);
  assert.equal(world.caddy.requests.length, 0);
  assert.equal(world.caddy.probes.length, 0);
  assert.deepEqual(world.fake.discoveredDevices, []);
  const widget = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'de' });
  assert.match(widget.data.content.components[0].text, /Gib die Adresse/);
  const ack = await world.fake.sceneAction('get_caddy_status', {});
  assert.equal(ack.success, false);
});

async function captureLogs(t, level, fn) {
  const lines = [];
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const before = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = before;
  }
  return lines;
}

test('a normal reading cycle writes nothing at the info level', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const lines = await captureLogs(t, 'info', async () => {
    for (let cycle = 0; cycle < 6; cycle += 1) {
      world.caddy.upstreams[1].num_requests = cycle;
      world.clock.advance(20 * 60_000); // certificates read again on the way
      await world.hub.pollNow();
    }
  });
  assert.ok(world.caddy.probes.length > 3);
  assert.deepEqual(lines, []);
});

test('a lasting failure writes one line, not one per read', async (t) => {
  const world = await createWorld({ caddy: new FakeCaddy({ auth: 'gladys:s3cret' }) });
  t.after(() => world.app.stop());
  const lines = await captureLogs(t, 'info', async () => {
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await world.hub.pollNow();
    }
  });
  assert.equal(lines.length, 0, lines.join('\n')); // logged at start, never reachable since
  world.caddy.auth = null;
  await world.hub.pollNow();
  world.caddy.failure = 'down';
  const down = await captureLogs(t, 'info', async () => {
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await world.hub.pollNow();
    }
  });
  assert.equal(down.length, 2, down.join('\n')); // the error, then "unreachable"
});

test('the widget: tiles, sites down first, upstreams down, within the budget', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.caddy.certificates.set('www.example.test', certificate(5));
  await world.hub.pollNow({ certificates: true });
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language });
    assert.equal(ack.success, true, ack.error);
    validateWidgetContent(ack.data.content);
    assert.ok(ack.data.content.components.length <= 8);
  }
  const {
    data: { content: data },
  } = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'fr' });
  assert.deepEqual(
    data.components.filter((c) => c.type === 'value').map((c) => [c.label, c.value]),
    [
      ['Amonts KO', 1],
      ['Certificats', 1],
      ['Sites OK', 4],
    ],
  );
  const [sites, upstreams] = data.components.filter((c) => c.type === 'status');
  assert.deepEqual(
    sites.items.map((i) => [i.label, i.value]),
    [
      ['broken.example.test', 'En panne · 0/1 · 60 j'],
      ['www.example.test', 'Certificat à renouveler · 2/2 · 5 j'],
      ['*.wild.example.test', 'OK'],
      ['app.example.test', 'OK · 2/2 · 60 j'],
      ['plain.example.test', 'OK · 1/1'],
    ],
  );
  assert.deepEqual(
    upstreams.items.map((i) => [i.label, i.value]),
    [['dead:80', 'broken.example.test']],
  );
  assert.ok(sites.items.every((i) => i.value.length <= 40));

  const ack = await world.fake.widgetAction(WIDGET_KEY, 'refresh', {});
  assert.equal(ack.success, true, ack.error);
});

test('the widget limited to chosen sites, and when Caddy does not answer', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const chosen = { sites: [idsOf(world, 'app.example.test').device] };
  const {
    data: { content: data },
  } = await world.fake.widgetGet(WIDGET_KEY, { settings: chosen, language: 'en' });
  const statuses = data.components.filter((c) => c.type === 'status');
  assert.equal(statuses.length, 1, 'dead:80 does not serve the chosen site');
  assert.deepEqual(
    statuses[0].items.map((i) => i.label),
    ['app.example.test'],
  );
  world.caddy.failure = 'down';
  await world.hub.pollNow();
  const down = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'en' });
  validateWidgetContent(down.data.content);
  assert.ok(down.data.content.components.some((c) => c.text === 'Caddy does not answer'));
});

test('scene actions: a site in a sentence, the whole server, unreachable as an answer', async (t) => {
  const clock = createClock();
  const world = await createWorld({ clock, config: { url: BASE, language: 'fr' } });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.caddy.setHealthy('whoami1:80', false);
  await world.hub.pollNow();
  clock.advance(20_000);
  const site = await world.fake.sceneAction('get_site_status', {
    device: idsOf(world, 'app.example.test').device,
  });
  assert.deepEqual(site.data.outputs, {
    healthy: true,
    state: 'Dégradé',
    upstreams_healthy: 1,
    upstreams_total: 2,
    certificate_days: 59,
    sentence:
      'app.example.test : Dégradé, 1/2 amont(s) sain(s), certificat valable encore 59 jour(s).',
  });
  const unknown = await world.fake.sceneAction('get_site_status', { device: 'nope' });
  assert.equal(unknown.success, false);

  const server = await world.fake.sceneAction('get_caddy_status', {});
  assert.equal(server.data.outputs.reachable, true);
  assert.equal(server.data.outputs.upstreams_down, 2);
  assert.equal(server.data.outputs.upstreams, 'dead:80, whoami1:80');
  assert.equal(server.data.outputs.sentence, 'Caddy : 2 amont(s) en panne (dead:80, whoami1:80).');

  world.caddy.failure = 'down';
  clock.advance(20_000);
  const down = await world.fake.sceneAction('get_caddy_status', {});
  assert.equal(down.success, true);
  assert.equal(down.data.outputs.reachable, false);
  assert.equal(down.data.outputs.sentence, 'Caddy : Caddy ne répond pas.');
});

test('"Test the connection" sums up Caddy in the four languages', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection', {});
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.en, 'Caddy: Connected, 5 site(s), 1 upstream(s) down');
  assert.match(ack.data.message.fr, /^Caddy : Connecté/);
  assert.equal(world.caddy.probes.length, 6, 'every certificate read again');
});

test('the internal timer reads Caddy and publishes the changes, without any poll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld({ timers: true });
  t.after(() => world.app.stop());
  await createDevices(world);
  const reads = world.caddy.requests.length;
  world.caddy.setHealthy('whoami1:80', false);
  for (let tick = 0; tick < 2; tick += 1) {
    t.mock.timers.tick(60_000);
    // Let the read and the publications settle.
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  assert.ok(world.caddy.requests.length > reads);
  assert.equal(siteState(world, 'app.example.test', SITE_KEYS.UPSTREAMS_HEALTHY), 1);
});

test('a damaged /data file does not block the reads', async (t) => {
  const first = await createWorld();
  await first.app.stop();
  writeFileSync(
    join(first.dataDir, 'caddy-state.json'),
    JSON.stringify({
      url: BASE,
      initialized: true,
      reachable: true,
      upstreams: { 'x:1': null, 'whoami1:80': 'oops' },
      sites: { 'a.example.test': 3 },
      certificates: { 'b.example.test': 'z' },
    }),
  );
  const second = await createWorld({ dataDir: first.dataDir });
  t.after(() => second.app.stop());
  await second.hub.pollNow();
  assert.equal(second.fake.connectionStatus.connected, true);
  assert.equal(second.hub.sites.size, 5);
});
