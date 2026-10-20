// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Does this site have a healthy upstream?" is already a scene condition on
// the device feature. The actions are about what a condition cannot do: put
// the state in a message ("cloud.example.com: Degraded, 1/2 upstream(s)
// healthy, certificate valid 63 more day(s)."), and sum up the whole server —
// upstreams down and certificates expiring, added to Gladys or not, or that
// Caddy does not answer. Both read Caddy again when the last read is older
// than 15 seconds. Nothing is ever written to Caddy.
// -----------------------------------------------------------------------------

import { daysLeft, readable } from './caddy/certificates.js';
import { upstreamCounts } from './devices.js';
import { ACTION_TEXT, REPORT_TEXT, SENTENCE_TEXT, STATE_TEXT, labelled, pick } from './texts.js';

// Names listed in the text outputs, at most (the rest is counted).
export const MAX_LISTED_NAMES = 20;

const listed = (names) => {
  const shown = names.slice(0, MAX_LISTED_NAMES);
  return names.length > shown.length
    ? `${shown.join(', ')}, +${names.length - shown.length}`
    : shown.join(', ');
};

const sortedNames = (items, key) =>
  items.map((item) => item[key]).sort((a, b) => a.localeCompare(b));

export const SCENE_ACTIONS = {
  async get_site_status(hub, { fields = {} }) {
    if (!hub.client) {
      hub.assertReadable(); // no address: the configuration to fix
    }
    await hub.refreshIfStale();
    if (!hub.reachable) {
      hub.assertReadable(); // one failed read is tolerated, as for the device
    }
    const language = hub.config.language;
    const site = hub.find(fields.device);
    if (!site) {
      throw new Error(pick(ACTION_TEXT.unknownSite, language));
    }
    const status = hub.stateOf(site);
    const state = pick(STATE_TEXT[status], language);
    const words = SENTENCE_TEXT[language] ?? SENTENCE_TEXT.en;
    const { healthy, total } = site.present
      ? upstreamCounts(site, hub.upstreams)
      : { healthy: 0, total: 0 };
    const certificate = hub.certificates.get(site.name);
    const days = readable(site) && certificate?.notAfter ? daysLeft(certificate, hub.now()) : null;
    const parts = [labelled(site.name, state, language)];
    if (total > 0) {
      parts.push(words.upstreams(healthy, total));
    }
    if (days !== null) {
      parts.push(words.days(days));
    }
    return {
      healthy: !['down', 'missing'].includes(status),
      state,
      upstreams_healthy: healthy,
      upstreams_total: total,
      certificate_days: days ?? 0,
      sentence: `${parts.join(', ')}.`,
    };
  },

  async get_caddy_status(hub) {
    if (!hub.client) {
      hub.assertReadable(); // no address: the configuration to fix
    }
    await hub.refreshIfStale();
    const language = hub.config.language;
    const text = REPORT_TEXT[language] ?? REPORT_TEXT.en;
    if (hub.error || !hub.reachable) {
      // "Caddy does not answer" is an answer: the scene goes on with it.
      return {
        reachable: false,
        sites: 0,
        upstreams_down: 0,
        upstreams: '',
        certificates_expiring: 0,
        certificates: '',
        sentence: `${labelled('Caddy', text.unreachable, language)}.`,
      };
    }
    const down = sortedNames(hub.upstreamsDown(), 'address');
    const expiring = sortedNames(hub.expiringSites(), 'name');
    const parts = [];
    if (down.length > 0) {
      parts.push(`${text.down(down.length)} (${listed(down)})`);
    }
    if (expiring.length > 0) {
      parts.push(`${text.expiring(expiring.length)} (${listed(expiring)})`);
    }
    return {
      reachable: true,
      sites: [...hub.sites.values()].filter((site) => site.present).length,
      upstreams_down: down.length,
      upstreams: listed(down),
      certificates_expiring: expiring.length,
      certificates: listed(expiring),
      sentence: `${labelled('Caddy', parts.length > 0 ? parts.join(', ') : text.healthy, language)}.`,
    };
  },
};
