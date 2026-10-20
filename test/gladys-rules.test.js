// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the real
// answers of Caddy v2.11 (test/fixtures/caddy: two sites on a load-balanced
// upstream, one on a stopped upstream, an http:// site, a wildcard site), in
// every feature-name language and with the variants of a site (certificate
// only, upstreams only).
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeCaddy, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

async function discover(language, prepare = () => {}) {
  const caddy = new FakeCaddy();
  prepare(caddy);
  const world = await createWorld({ caddy, config: { url: 'http://192.0.2.10:2019', language } });
  await world.app.stop();
  return world.fake.discoveredDevices;
}

// A site with a certificate and no upstream (file_server, respond).
const staticSite = (caddy) => {
  caddy.config.apps.http.servers.srv0.routes.push({
    match: [{ host: ['static.example.test'] }],
    handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'file_server' }] }] }],
    terminal: true,
  });
};

const scenarios = [
  { label: 'the fixture, English names', language: 'en' },
  {
    label: 'an upstream down, French names',
    language: 'fr',
    prepare: (c) => c.setHealthy('whoami1:80', false),
  },
  { label: 'a static site, German names', language: 'de', prepare: staticSite },
  { label: 'the fixture, Spanish names', language: 'es' },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const devices = await discover(scenario.language, scenario.prepare);
    assert.ok(devices.length >= 5, 'the server and the sites of the fixture');
    assert.equal(devices[0].name, 'Caddy');
    assert.equal(
      new Set(devices.map((device) => device.external_id)).size,
      devices.length,
      'unique device external ids',
    );

    for (const device of devices) {
      const where = device.name;

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          const allowed = table.units_by_category?.[feature.category];
          if (allowed) {
            assert.ok(
              allowed.includes(feature.unit),
              `${at}: ${feature.unit} for ${feature.category}`,
            );
          }
        }

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}
