// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one "Caddy" device for the server:
//       reachable              input/binary    1 the admin API answers
//       config_ok              input/binary    1 the last configuration load
//                                              succeeded (metrics)
//       sites                  counter-sensor  sites in the configuration
//       upstreams_down         counter-sensor  upstreams failing their health checks
//       certificates_expiring  counter-sensor  certificates late for renewal
//
//   - one device per site (host name of the configuration), identified by
//     that name, with the features that apply to it:
//       certificate_days       duration (days) days before the certificate
//                                              expires (HTTPS sites)
//       upstreams_healthy      counter-sensor  upstreams passing their health checks
//       upstreams_total        counter-sensor  upstreams of its reverse_proxy
//
// Published with should_poll: false: the integration reads Caddy on its own
// timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { daysLeft, isExpiring, readable } from './caddy/certificates.js';

export const SERVER_TYPE = 'server';
export const SERVER_ID = 'main';
export const SITE_TYPE = 'site';
export const MODEL = 'Caddy';

// Suffixes of the feature external ids: permanent once published.
export const SERVER_KEYS = Object.freeze({
  REACHABLE: 'reachable',
  CONFIG_OK: 'config_ok',
  SITES: 'sites',
  UPSTREAMS_DOWN: 'upstreams_down',
  CERTIFICATES_EXPIRING: 'certificates_expiring',
});

export const SITE_KEYS = Object.freeze({
  CERTIFICATE_DAYS: 'certificate_days',
  UPSTREAMS_HEALTHY: 'upstreams_healthy',
  UPSTREAMS_TOTAL: 'upstreams_total',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [SERVER_KEYS.REACHABLE]: 'Reachable',
    [SERVER_KEYS.CONFIG_OK]: 'Configuration loaded',
    [SERVER_KEYS.SITES]: 'Sites',
    [SERVER_KEYS.UPSTREAMS_DOWN]: 'Upstreams down',
    [SERVER_KEYS.CERTIFICATES_EXPIRING]: 'Certificates expiring',
    [SITE_KEYS.CERTIFICATE_DAYS]: 'Certificate expiry',
    [SITE_KEYS.UPSTREAMS_HEALTHY]: 'Healthy upstreams',
    [SITE_KEYS.UPSTREAMS_TOTAL]: 'Upstreams in total',
  },
  fr: {
    [SERVER_KEYS.REACHABLE]: 'Joignable',
    [SERVER_KEYS.CONFIG_OK]: 'Configuration chargée',
    [SERVER_KEYS.SITES]: 'Sites',
    [SERVER_KEYS.UPSTREAMS_DOWN]: 'Amonts en panne',
    [SERVER_KEYS.CERTIFICATES_EXPIRING]: 'Certificats à renouveler',
    [SITE_KEYS.CERTIFICATE_DAYS]: 'Expiration du certificat',
    [SITE_KEYS.UPSTREAMS_HEALTHY]: 'Amonts sains',
    [SITE_KEYS.UPSTREAMS_TOTAL]: 'Amonts au total',
  },
  de: {
    [SERVER_KEYS.REACHABLE]: 'Erreichbar',
    [SERVER_KEYS.CONFIG_OK]: 'Konfiguration geladen',
    [SERVER_KEYS.SITES]: 'Sites',
    [SERVER_KEYS.UPSTREAMS_DOWN]: 'Ausgefallene Upstreams',
    [SERVER_KEYS.CERTIFICATES_EXPIRING]: 'Ablaufende Zertifikate',
    [SITE_KEYS.CERTIFICATE_DAYS]: 'Ablauf des Zertifikats',
    [SITE_KEYS.UPSTREAMS_HEALTHY]: 'Funktionierende Upstreams',
    [SITE_KEYS.UPSTREAMS_TOTAL]: 'Upstreams insgesamt',
  },
  es: {
    [SERVER_KEYS.REACHABLE]: 'Accesible',
    [SERVER_KEYS.CONFIG_OK]: 'Configuración cargada',
    [SERVER_KEYS.SITES]: 'Sitios',
    [SERVER_KEYS.UPSTREAMS_DOWN]: 'Upstreams caídos',
    [SERVER_KEYS.CERTIFICATES_EXPIRING]: 'Certificados por renovar',
    [SITE_KEYS.CERTIFICATE_DAYS]: 'Caducidad del certificado',
    [SITE_KEYS.UPSTREAMS_HEALTHY]: 'Upstreams en buen estado',
    [SITE_KEYS.UPSTREAMS_TOTAL]: 'Upstreams en total',
  },
};

// Display bounds (the core never applies them on write).
export const MAX_COUNT = 10_000;
export const MAX_UPSTREAMS = 1_000;
export const MIN_DAYS = -3650;
export const MAX_DAYS = 3650;

/**
 * The state of a site, worst first: missing (gone from the configuration),
 * down (no healthy upstream), degraded (some), expiring (certificate late for
 * renewal), up.
 * @param {object} site { present, upstreams }
 * @param {Map<string, object>} upstreams by address
 * @param {object|undefined} certificate
 * @returns {'missing'|'down'|'degraded'|'expiring'|'up'}
 */
export function stateOf(site, upstreams, certificate, now, expiryDays) {
  if (!site.present) {
    return 'missing';
  }
  const { healthy, total } = upstreamCounts(site, upstreams);
  if (total > 0 && healthy === 0) {
    return 'down';
  }
  if (healthy < total) {
    return 'degraded';
  }
  if (certificate?.notAfter && isExpiring(certificate, now, expiryDays)) {
    return 'expiring';
  }
  return 'up';
}

/** Healthy and total upstreams of a site (an unknown upstream counts healthy). */
export function upstreamCounts(site, upstreams) {
  const total = site.upstreams.length;
  const healthy = site.upstreams.filter((address) => upstreams.get(address)?.healthy !== false);
  return { healthy: healthy.length, total };
}

// Site names hold letters, digits, `-`, `.`, `*` and, for a site without host,
// its listen address: anything else would only make the external id harder to read.
export const platformIdOf = (name) => name.replace(/[^A-Za-z0-9._-]/g, '_');

export const siteIds = (gladys, name) => gladys.externalIds(SITE_TYPE, platformIdOf(name));
export const serverIds = (gladys) => gladys.externalIds(SERVER_TYPE, SERVER_ID);

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const binary = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.INPUT, DEVICE_FEATURE_TYPES.SENSOR.BINARY, {
    keep_history: true,
    min: 0,
    max: 1,
  });

const counter = (name, externalId, max) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    { keep_history: true, min: 0, max },
  );

/** The discovery payload of the server. */
export function buildServerDevice(gladys, language = 'en') {
  const ids = serverIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: 'Caddy',
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: [
      binary(names[SERVER_KEYS.REACHABLE], ids.feature(SERVER_KEYS.REACHABLE)),
      binary(names[SERVER_KEYS.CONFIG_OK], ids.feature(SERVER_KEYS.CONFIG_OK)),
      ...[SERVER_KEYS.SITES, SERVER_KEYS.UPSTREAMS_DOWN, SERVER_KEYS.CERTIFICATES_EXPIRING].map(
        (key) => counter(names[key], ids.feature(key), MAX_COUNT),
      ),
    ],
  };
}

/** Whether a site device has features: a certificate to read, or upstreams. */
export const hasFeatures = (site) => readable(site) || site.upstreams.length > 0;

/** The discovery payload of a site. */
export function buildSiteDevice(gladys, site, language = 'en') {
  const ids = siteIds(gladys, site.name);
  const names = NAMES[language] ?? NAMES.en;
  const features = [];
  if (readable(site)) {
    features.push(
      sensor(
        names[SITE_KEYS.CERTIFICATE_DAYS],
        ids.feature(SITE_KEYS.CERTIFICATE_DAYS),
        DEVICE_FEATURE_CATEGORIES.DURATION,
        DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        { keep_history: true, unit: DEVICE_FEATURE_UNITS.DAYS, min: MIN_DAYS, max: MAX_DAYS },
      ),
    );
  }
  if (site.upstreams.length > 0) {
    features.push(
      counter(
        names[SITE_KEYS.UPSTREAMS_HEALTHY],
        ids.feature(SITE_KEYS.UPSTREAMS_HEALTHY),
        MAX_UPSTREAMS,
      ),
      counter(
        names[SITE_KEYS.UPSTREAMS_TOTAL],
        ids.feature(SITE_KEYS.UPSTREAMS_TOTAL),
        MAX_UPSTREAMS,
      ),
    );
  }
  return {
    name: site.name.slice(0, 255),
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: readable(site) && site.port ? [{ name: 'PORT', value: String(site.port) }] : [],
    features,
  };
}

/**
 * The values of a site device. A missing site has no upstream; its
 * certificate keeps its last value.
 */
export function siteValues(gladys, site, upstreams, certificate, now) {
  const ids = siteIds(gladys, site.name);
  const values = [];
  if (readable(site) && certificate?.notAfter) {
    values.push({ key: SITE_KEYS.CERTIFICATE_DAYS, state: daysLeft(certificate, now) });
  }
  if (site.upstreams.length > 0) {
    const { healthy, total } = site.present
      ? upstreamCounts(site, upstreams)
      : { healthy: 0, total: 0 };
    values.push(
      { key: SITE_KEYS.UPSTREAMS_HEALTHY, state: healthy },
      { key: SITE_KEYS.UPSTREAMS_TOTAL, state: total },
    );
  }
  return values.map(({ key, state }) => ({
    device_feature_external_id: ids.feature(key),
    state: Math.max(MIN_DAYS, Math.min(MAX_DAYS, state)),
  }));
}

/**
 * The values of the server device: only "reachable" when Caddy does not
 * answer (the counts keep their last value).
 */
export function serverValues(gladys, { reachable, reloadOk, sites, upstreamsDown, expiring }) {
  const ids = serverIds(gladys);
  const values = [{ key: SERVER_KEYS.REACHABLE, state: reachable ? 1 : 0 }];
  if (reachable) {
    if (typeof reloadOk === 'boolean') {
      values.push({ key: SERVER_KEYS.CONFIG_OK, state: reloadOk ? 1 : 0 });
    }
    values.push(
      { key: SERVER_KEYS.SITES, state: sites },
      { key: SERVER_KEYS.UPSTREAMS_DOWN, state: upstreamsDown },
      { key: SERVER_KEYS.CERTIFICATES_EXPIRING, state: expiring },
    );
  }
  return values.map(({ key, state }) => ({ device_feature_external_id: ids.feature(key), state }));
}
