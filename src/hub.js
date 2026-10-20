// -----------------------------------------------------------------------------
// The Caddy hub: the admin API read on a timer of the container (the interval
// chosen in the configuration) and the certificates once an hour; the states
// of the added devices published when they change, the scene events fired on
// transitions, and the views the widget and the scene actions read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire for every upstream and site, added to Gladys or not.
//
// The last health of each upstream, the sites, the certificates already
// announced and the reachability of Caddy are kept in /data (src/store.js):
// what changed while the integration or Gladys restarted is still announced,
// once. (Adapted from guim31/gladys-traefik.)
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  buildServerDevice,
  buildSiteDevice,
  hasFeatures,
  serverIds,
  serverValues,
  siteIds,
  siteValues,
  stateOf,
} from './devices.js';
import { CaddyClient, CaddyError } from './caddy/client.js';
import { daysLeft, isExpiring, probeCertificate, readable } from './caddy/certificates.js';
import { hostOf, normalizeConfig } from './config.js';
import { ProblemLog } from './problems.js';
import { CONNECTION_TEXT, ERROR_TEXT, REPORT_TEXT, labelled, pick } from './texts.js';

const logger = createLogger({ name: 'caddy-hub' });

export const WIDGET_KEY = 'caddy';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  UPSTREAM_DOWN: 'upstream_down',
  UPSTREAM_UP: 'upstream_up',
  CERTIFICATE_EXPIRING: 'certificate_expiring',
  UNREACHABLE: 'caddy_unreachable',
});

export const HUB_TIMINGS = {
  // An unchanged value is sent again this often: Gladys shows "no recent
  // value" after 48 hours.
  heartbeatMs: 12 * 3600_000,
  // A scene action reads Caddy again when the last read is older.
  freshMs: 15_000,
  // The certificates change rarely: one handshake per site and per hour.
  certificatesMs: 3600_000,
  // A refused handshake is tried again sooner.
  certificateRetryMs: 5 * 60_000,
};

// Failed reads in a row before Caddy counts as unreachable: a restart of
// Caddy (a second) does not fire the scenes.
export const FAILURES_BEFORE_UNREACHABLE = 2;

// Reads in a row before a change of health or presence counts: a Caddy that
// just restarted reports every upstream healthy until its first health check.
export const CONFIRM_READS = 2;

// Certificates read at once.
const CERTIFICATE_CONCURRENCY = 4;
const MAX_TRANSPORTS_PER_REQUEST = 100;
const MAX_EVENT_TEXT = 1000;

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export class CaddyHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/caddy/client.js)
   * @param {Function} [options.probe] TLS seam (src/caddy/certificates.js)
   * @param {boolean} [options.timers] the reading timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, probe, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.probe = probe ?? probeCertificate;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    // Defaults until start(): a handler reached after a failed start still
    // answers with a readable message.
    this.config = normalizeConfig({});
    this.client = null;
    this.signature = null;
    this.resetReadings();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    /** Set when the address changed: the Discovery list of the old Caddy goes. */
    this.clearDiscovery = false;
    this.saved = emptySaved(null);
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.problems = new ProblemLog(logger);
  }

  resetReadings() {
    /** @type {Map<string, object>} sites of the last read (and the added ones gone), by name */
    this.sites = new Map();
    /** @type {Map<string, object>} upstreams of the last read, by address */
    this.upstreams = new Map();
    /** @type {Map<string, object>} certificates read, by site name */
    this.certificates = new Map();
    this.reloadOk = null;
    this.loaded = false;
    this.readAt = 0;
    this.error = null;
    this.failures = 0;
    this.polling = null;
    this.reading = null;
    /** Changes seen on fewer than CONFIRM_READS reads, by key. */
    this.pending = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = object(await this.store.load());
    // A hand-edited or damaged file must not block the reads.
    const entries = (value, keep) =>
      Object.fromEntries(Object.entries(object(value)).filter(([, entry]) => keep(entry)));
    this.saved = {
      initialized: saved.initialized === true,
      reachable: typeof saved.reachable === 'boolean' ? saved.reachable : null,
      url: typeof saved.url === 'string' ? saved.url : null,
      upstreams: entries(
        saved.upstreams,
        (entry) => typeof entry?.healthy === 'boolean' && typeof entry.since === 'number',
      ),
      sites: entries(saved.sites, (entry) => Array.isArray(entry?.upstreams)),
      certificates: entries(saved.certificates, (notAfter) => typeof notAfter === 'number'),
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.signature !== null && this.config.language !== config.language;
    this.config = config;
    const signature = JSON.stringify([
      config.url,
      config.username,
      config.password,
      config.certificateHost,
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.client = config.url
        ? new CaddyClient({
            url: config.url,
            username: config.username,
            password: config.password,
            request: this.request,
            debug: (message) => logger.debug(message),
          })
        : null;
      this.resetReadings();
      // Another Caddy: what was saved about the previous one means nothing.
      if (config.url && this.saved.url !== config.url) {
        this.clearDiscovery = this.saved.url !== null;
        this.saved = emptySaved(config.url);
      }
    }
    if (languageChanged) {
      this.discovered = null; // new feature names for the Discovery tab
    }
    try {
      if (this.client) {
        await this.pollNow({ publish: true });
      } else {
        await this.afterChanges(true, { publish: true });
      }
    } finally {
      this.schedulePoll();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollNow();
        this.problems.recover('poll', 'Reading Caddy works again');
      } catch (err) {
        this.problems.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading Caddy -----------------------------------------------------------

  /**
   * Read Caddy now (and the certificates due, or all with `certificates`),
   * then publish what changed.
   */
  async pollNow({ publish = false, certificates = false } = {}) {
    let changed = await this.poll();
    changed = (await this.readCertificates({ force: certificates })) || changed;
    await this.afterChanges(changed, { publish });
  }

  /** Read again when the last read is older than `freshMs` (scene actions). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollNow();
    }
  }

  /**
   * Read Caddy and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll() {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (!this.polling) {
      const polling = this.read(this.client).finally(() => {
        // A read of a previous client must not drop the promise of the current one.
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  async read(client) {
    let snapshot;
    try {
      snapshot = await client.snapshot();
    } catch (err) {
      if (!(err instanceof CaddyError)) {
        throw err;
      }
      return client === this.client && this.applyFailure(err);
    }
    return client === this.client && this.applySuccess(snapshot);
  }

  /** Whether Caddy counts as reachable (after a few failed reads in a row). */
  get reachable() {
    return this.readAt > 0 && this.saved.reachable !== false && this.loaded;
  }

  /**
   * A change of `key` to `value` counts once seen on CONFIRM_READS reads in
   * a row; until then `current` stays.
   */
  settle(key, value, current) {
    if (value === current) {
      this.pending.delete(key);
      return current;
    }
    const seen = this.pending.get(key);
    const count = seen?.value === value ? seen.count + 1 : 1;
    if (count >= CONFIRM_READS) {
      this.pending.delete(key);
      return value;
    }
    this.pending.set(key, { value, count });
    return current;
  }

  async applySuccess({ sites, upstreams, reloadOk }) {
    // Everything below up to the scene events is synchronous: a configuration
    // change cannot slip between the reading and the saved state it updates.
    const saved = this.saved;
    const client = this.client;
    const now = this.now();
    let widgetChanged = this.error !== null || this.readAt === 0 || reloadOk !== this.reloadOk;
    if (this.error || saved.reachable === false) {
      logger.info('Caddy answers again');
    }
    if (this.readAt === 0) {
      logger.info(
        `Caddy (${hostOf(this.config.url)}): ${sites.length} site(s), ${upstreams.length} upstream(s)`,
      );
    }
    let dirty = saved.reachable !== true || !saved.initialized;
    const initialized = saved.initialized;
    this.error = null;
    this.failures = 0;
    saved.reachable = true;
    saved.initialized = true;
    this.reloadOk = reloadOk;
    this.loaded = true;
    this.readAt = now;
    const events = [];

    // Sites: the ones of the configuration, and the ones gone from it whose
    // device is added to Gladys (shown as missing). Gone after CONFIRM_READS
    // reads without them: a Caddy that restarts may answer with an empty
    // configuration for a moment.
    const next = new Map();
    for (const site of sites) {
      next.set(site.name, { ...site, present: true });
      this.pending.delete(`site:${site.name}`);
      const known = saved.sites[site.name];
      const description = { https: site.https, port: site.port, upstreams: site.upstreams };
      if (!known || known.missing || JSON.stringify(known) !== JSON.stringify(description)) {
        saved.sites[site.name] = description;
        dirty = true;
      }
    }
    for (const [name, known] of Object.entries(saved.sites)) {
      if (next.has(name)) {
        continue;
      }
      if (!known.missing && this.settle(`site:${name}`, 'gone', 'here') === 'here') {
        const shown = this.sites.get(name);
        if (shown) {
          next.set(name, shown); // not gone yet: keep what was shown
        }
        continue;
      }
      if (this.isCreated(siteIds(this.gladys, name).device)) {
        if (!known.missing) {
          logger.info(`Site ${name} is gone from the configuration`);
          known.missing = true;
          dirty = true;
        }
        next.set(name, {
          name,
          https: known.https,
          port: known.port,
          upstreams: known.upstreams,
          present: false,
        });
      } else {
        delete saved.sites[name];
        dirty = true;
      }
    }
    const siteStates = (map) =>
      JSON.stringify([...map.values()].map((site) => [site.name, site.present, site.upstreams]));
    if (siteStates(next) !== siteStates(this.sites)) {
      widgetChanged = true;
    }
    this.sites = next;

    // Upstreams: health changes after CONFIRM_READS reads; an upstream seen
    // for the first time after the first read is announced only when it
    // appears already down (a new backend that fails).
    const sitesOf = (address) =>
      sites.filter((site) => site.upstreams.includes(address)).map((site) => site.name);
    const nextUpstreams = new Map();
    for (const upstream of upstreams) {
      const { address } = upstream;
      this.pending.delete(`upstream-gone:${address}`);
      const previous = saved.upstreams[address];
      const healthy = previous
        ? this.settle(`upstream:${address}`, upstream.healthy, previous.healthy)
        : upstream.healthy;
      const view = { ...upstream, healthy, sites: sitesOf(address) };
      nextUpstreams.set(address, view);
      if (previous?.healthy === healthy) {
        continue;
      }
      saved.upstreams[address] = { healthy, since: now };
      dirty = true;
      widgetChanged = true;
      if (!initialized || (!previous && healthy)) {
        continue;
      }
      const data = {
        upstream: address,
        sites: view.sites.join(', ').slice(0, MAX_EVENT_TEXT),
      };
      if (!healthy) {
        logger.info(`Upstream ${address} is down`);
        events.push([TRIGGERS.UPSTREAM_DOWN, { ...data, fails: upstream.fails }]);
      } else {
        const minutes = Math.max(0, Math.round((now - previous.since) / 60_000));
        logger.info(`Upstream ${address} is up again after ${minutes} min`);
        events.push([TRIGGERS.UPSTREAM_UP, { ...data, downtime_minutes: minutes }]);
      }
    }
    for (const address of Object.keys(saved.upstreams)) {
      if (nextUpstreams.has(address)) {
        continue;
      }
      if (this.settle(`upstream-gone:${address}`, 'gone', 'here') === 'gone') {
        delete saved.upstreams[address];
        this.pending.delete(`upstream:${address}`);
        dirty = true;
        widgetChanged = true;
      } else if (this.upstreams.has(address)) {
        nextUpstreams.set(address, this.upstreams.get(address));
      }
    }
    this.upstreams = nextUpstreams;

    // Written only when something changed: no wear of the SD card at every read.
    if (dirty) {
      this.store.save(saved);
    }
    for (const [key, data] of events) {
      if (client !== this.client) {
        return false; // reconfigured meanwhile: the old Caddy's news are stale
      }
      await this.fire(key, data);
    }
    if (client === this.client) {
      await this.publishStates();
    }
    return widgetChanged;
  }

  async applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.failures += 1;
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`Caddy: ${err.message}`);
    }
    if (this.failures >= FAILURES_BEFORE_UNREACHABLE && this.saved.reachable !== false) {
      const wasReachable = this.saved.reachable === true;
      this.saved.reachable = false;
      this.store.save(this.saved);
      if (wasReachable) {
        logger.info('Caddy is unreachable');
        await this.fire(TRIGGERS.UNREACHABLE, {
          error: pick(ERROR_TEXT[err.kind], this.config.language),
        });
      }
    }
    // Every failed read: "reachable" 0 once unreachable, and its heartbeat
    // during a long outage (the SDK skips the repeats).
    await this.publishStates();
    return wasError !== err.kind;
  }

  // --- Certificates --------------------------------------------------------------

  /**
   * Read the certificates that are due (every one with `force`), then announce
   * the ones late for renewal. Concurrent calls share the reading.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  readCertificates({ force = false } = {}) {
    if (!this.client || !this.reachable) {
      return Promise.resolve(false);
    }
    if (!this.reading) {
      const reading = this.probeDue(this.client, force).finally(() => {
        if (this.reading === reading) {
          this.reading = null;
        }
      });
      this.reading = reading;
    }
    return this.reading;
  }

  async probeDue(client, force) {
    const now = this.now();
    const due = [...this.sites.values()].filter((site) => {
      if (!site.present || !readable(site)) {
        return false;
      }
      const known = this.certificates.get(site.name);
      const wait = known?.error ? this.timings.certificateRetryMs : this.timings.certificatesMs;
      return force || !known || now - known.readAt >= wait;
    });
    if (due.length === 0) {
      return false;
    }
    const results = new Map();
    const queue = [...due];
    const worker = async () => {
      while (queue.length > 0) {
        const site = queue.shift();
        try {
          results.set(site.name, {
            ...(await this.probe({
              host: this.config.certificateHost,
              port: site.port,
              servername: site.name.replace(/\.$/, ''),
            })),
            readAt: now,
            error: null,
          });
        } catch (err) {
          results.set(site.name, { error: err.code ?? err.message, readAt: now });
        }
      }
    };
    await Promise.all(Array.from({ length: CERTIFICATE_CONCURRENCY }, worker));
    if (client !== this.client) {
      return false; // reconfigured meanwhile
    }
    let widgetChanged = false;
    for (const [name, result] of results) {
      const previous = this.certificates.get(name);
      if (result.error) {
        // The last date read stays: it still says when the certificate expires.
        if (previous?.error !== result.error) {
          this.problems.fail(
            `certificate:${name}`,
            `Certificate of ${name} not read: ${result.error}`,
          );
          widgetChanged = true;
        }
        this.certificates.set(name, { ...previous, error: result.error, readAt: now });
        continue;
      }
      this.problems.recover(`certificate:${name}`, `Certificate of ${name} read again`);
      if (previous?.notAfter !== result.notAfter || previous?.error) {
        widgetChanged = true;
      }
      this.certificates.set(name, result);
    }
    await this.announceExpiring();
    await this.publishStates();
    return widgetChanged;
  }

  /** Certificates late for renewal: announced once each (by expiry date). */
  async announceExpiring() {
    const saved = this.saved;
    const now = this.now();
    let dirty = false;
    const events = [];
    for (const [name, announced] of Object.entries(saved.certificates)) {
      const certificate = this.certificates.get(name);
      const site = this.sites.get(name);
      // Renewed (another expiry date), or the site gone: armed again.
      if (!site || (certificate?.notAfter && certificate.notAfter !== announced)) {
        delete saved.certificates[name];
        dirty = true;
      }
    }
    for (const [name, certificate] of this.certificates) {
      const site = this.sites.get(name);
      if (!site?.present || !certificate.notAfter) {
        continue;
      }
      if (!isExpiring(certificate, now, this.config.expiryDays)) {
        continue;
      }
      if (saved.certificates[name] === certificate.notAfter) {
        continue;
      }
      saved.certificates[name] = certificate.notAfter;
      dirty = true;
      const days = daysLeft(certificate, now);
      logger.info(`Certificate of ${name} expires in ${days} day(s)`);
      events.push({
        device: siteIds(this.gladys, name).device,
        site: name,
        days_left: days,
        expires_at: isoDate(certificate.notAfter),
        issuer: certificate.issuer || '-',
      });
    }
    if (dirty) {
      this.store.save(saved);
    }
    for (const data of events) {
      await this.fire(TRIGGERS.CERTIFICATE_EXPIRING, data);
    }
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Views -----------------------------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /** The state of a site, worst first (see devices.js). */
  stateOf(site) {
    return stateOf(
      site,
      this.upstreams,
      this.certificates.get(site.name),
      this.now(),
      this.config.expiryDays,
    );
  }

  /** The site of a device external id, null when it is not one of ours. */
  find(externalId) {
    if (typeof externalId !== 'string') {
      return null;
    }
    for (const site of this.sites.values()) {
      if (siteIds(this.gladys, site.name).device === externalId) {
        return site;
      }
    }
    return null;
  }

  upstreamsDown() {
    return [...this.upstreams.values()].filter((upstream) => !upstream.healthy);
  }

  /** The sites whose certificate is late for renewal. */
  expiringSites() {
    const now = this.now();
    return [...this.sites.values()].filter((site) => {
      const certificate = this.certificates.get(site.name);
      return (
        site.present &&
        certificate?.notAfter &&
        isExpiring(certificate, now, this.config.expiryDays)
      );
    });
  }

  /** Throws the reason Caddy cannot answer, if any. */
  assertReadable() {
    const status = this.connectionStatus();
    if (!status.connected) {
      throw new Error(pick(status.message, this.config.language));
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------

  discoveredDevices() {
    if (!this.client || !this.reachable) {
      return null; // nothing read: keep the list Gladys has
    }
    const language = this.config.language;
    return [
      buildServerDevice(this.gladys, language),
      ...[...this.sites.values()]
        .filter((site) => site.present && hasFeatures(site))
        .map((site) => buildSiteDevice(this.gladys, site, language)),
    ];
  }

  /** Publish the Discovery list when it changed (a site added, a language…). */
  async publishDevices({ force = false } = {}) {
    const devices = this.discoveredDevices() ?? (!this.client || this.clearDiscovery ? [] : null);
    if (devices === null) {
      return;
    }
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.clearDiscovery = false;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read Caddy, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.readCertificates();
    await this.afterChanges(true, { publish: true });
  }

  /**
   * The user added (or updated) a device: its states sent before were dropped
   * by Gladys, and a device deleted then added again needs its badge.
   */
  async onDeviceCreated(device) {
    this.transports.delete(device.external_id);
    await this.publishStates();
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll, only if it polls anyway). */
  async pollDevice() {
    await this.pollNow();
  }

  /**
   * The states of the added devices. The SDK skips the values Gladys already
   * has (and sends an unchanged one again after `heartbeatMs`).
   */
  async publishStates() {
    if (this.readAt === 0) {
      return; // never read: nothing to tell
    }
    const now = this.now();
    const states = [];
    if (this.reachable) {
      for (const site of this.sites.values()) {
        if (this.isCreated(siteIds(this.gladys, site.name).device)) {
          states.push(
            ...siteValues(this.gladys, site, this.upstreams, this.certificates.get(site.name), now),
          );
        }
      }
    }
    if (this.isCreated(serverIds(this.gladys).device)) {
      states.push(
        ...serverValues(this.gladys, {
          reachable: this.reachable,
          reloadOk: this.reloadOk,
          sites: [...this.sites.values()].filter((site) => site.present).length,
          upstreamsDown: this.upstreamsDown().length,
          expiring: this.expiringSites().length,
        }),
      );
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: local, or unreachable. */
  async publishTransports() {
    if (!this.client || this.readAt === 0) {
      return;
    }
    const transport = this.reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    const entries = [];
    const ids = [
      serverIds(this.gladys).device,
      ...[...this.sites.keys()].map((name) => siteIds(this.gladys, name).device),
    ];
    for (const externalId of ids) {
      if (this.isCreated(externalId) && this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.problems.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.problems.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (this.config.url === '') {
      return { connected: false, message: CONNECTION_TEXT.noUrl };
    }
    if (!this.config.url) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (this.error) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.problems.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.problems.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  /** "Test the connection": read Caddy and every certificate now, one line. */
  async testConnection() {
    await this.pollNow({ publish: true, certificates: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const status = this.connectionStatus();
      if (!status.connected) {
        message[language] = pick(status.message, language);
        continue;
      }
      const sites = [...this.sites.values()].filter((site) => site.present);
      const parts = [text.ok, text.sites(sites.length)];
      const down = this.upstreamsDown().length;
      if (down > 0) {
        parts.push(text.down(down));
      }
      const expiring = this.expiringSites().length;
      if (expiring > 0) {
        parts.push(text.expiring(expiring));
      }
      message[language] = labelled('Caddy', parts.join(', '), language);
    }
    return message;
  }
}

function emptySaved(url) {
  return {
    initialized: false,
    reachable: null,
    url,
    upstreams: {},
    sites: {},
    certificates: {},
  };
}
