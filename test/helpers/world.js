// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake Caddy, a temporary
// /data and a manual clock, with the integration wired on top through
// registerHandlers. No timer runs: the tests read Caddy with
// `world.hub.pollNow()`. (Adapted from guim31/gladys-traefik.)
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { siteIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { BASE, FIXTURES, FakeCaddy, NOW, certificate } from './fakeCaddy.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

/** A manual clock, shared by the hub, the fake certificates and the tests. */
export function createClock(start = NOW) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export async function createWorld({
  clock = createClock(),
  caddy = new FakeCaddy(),
  config = { url: BASE, language: 'en' },
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-caddy-')),
  timings = {},
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: caddy.request,
    probe: caddy.probe,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, caddy, app, hub: app.hub, clock, dataDir };
}

/** External ids of the device of a site, by name. */
export const idsOf = (world, name) => siteIds(world.gladys, name);

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

/** Read Caddy as many times as a change needs to be confirmed. */
export async function confirm(world) {
  await world.hub.pollNow();
  await world.hub.pollNow();
}

export { BASE, FIXTURES, FakeCaddy, NOW, certificate };
