// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `caddy`.
//
// The use case: a glance at the wall tablet tells whether the self-hosted
// sites behind Caddy answer and keep a valid certificate, and which one does
// not. So the widget shows the upstreams down, the certificates expiring and
// the sites working, then one row per site — down first, then degraded, then
// expiring, then the others — with its healthy upstreams and the days left
// on its certificate, and the upstreams down with their sites.
//
// Every site by default, or the ones chosen in the widget settings (devices
// added to Gladys). The figures are sent as values, not bound to device
// features: the widget works before the devices are added.
//
// Budget (8 components, 2 texts): three tiles, one text when Caddy does not
// answer, two status lists (sites, upstreams down), a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { daysLeft, readable } from './caddy/certificates.js';
import { upstreamCounts } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { ERROR_TEXT, STATE_TEXT, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;
export const MAX_UPSTREAM_ROWS = 5;

export const TEXT = {
  pick: {
    en: 'Enter the address of the Caddy admin API in the configuration of the integration.',
    fr: "Saisissez l'adresse de l'API d'administration de Caddy dans la configuration de l'intégration.",
    de: 'Gib die Adresse der Admin-API von Caddy in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de la API de administración de Caddy en la configuración de la integración.',
  },
  empty: {
    en: 'No site in the configuration of Caddy yet.',
    fr: 'Aucun site dans la configuration de Caddy pour le moment.',
    de: 'Noch keine Site in der Konfiguration von Caddy.',
    es: 'Todavía no hay ningún sitio en la configuración de Caddy.',
  },
  down: { en: 'Upstreams down', fr: 'Amonts KO', de: 'Upstreams aus', es: 'Upstreams KO' },
  expiring: { en: 'Certificates', fr: 'Certificats', de: 'Zertifikate', es: 'Certificados' },
  up: { en: 'Sites OK', fr: 'Sites OK', de: 'Sites OK', es: 'Sitios OK' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  days: { en: 'd', fr: 'j', de: 'T', es: 'd' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Caddy and its certificates read again.',
    fr: 'Caddy et ses certificats relus.',
    de: 'Caddy und seine Zertifikate neu gelesen.',
    es: 'Caddy y sus certificados leídos de nuevo.',
  },
};

// Row order: what needs attention first.
const SEVERITY = ['down', 'missing', 'degraded', 'expiring', 'up'];

const ROW_STYLE = {
  down: { icon: 'x-circle', color: WIDGET_COLORS.DANGER },
  missing: { icon: 'help-circle', color: WIDGET_COLORS.DANGER },
  degraded: { icon: 'alert-triangle', color: WIDGET_COLORS.WARNING },
  expiring: { icon: 'lock', color: WIDGET_COLORS.WARNING },
  up: { icon: 'check-circle', color: WIDGET_COLORS.SUCCESS },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

/** The sites the widget shows: the chosen devices, or every site. */
export function selectSites(hub, settings) {
  const chosen = [settings?.sites ?? []].flat().filter((id) => typeof id === 'string' && id);
  if (chosen.length === 0) {
    return [...hub.sites.values()];
  }
  return [...new Set(chosen)].map((id) => hub.find(id)).filter(Boolean);
}

function rowValue(hub, site, language) {
  const state = hub.stateOf(site);
  const parts = [pick(STATE_TEXT[state], language)];
  if (state === 'missing') {
    return parts[0];
  }
  const { healthy, total } = upstreamCounts(site, hub.upstreams);
  if (total > 0) {
    parts.push(`${healthy}/${total}`);
  }
  const certificate = hub.certificates.get(site.name);
  if (readable(site) && certificate?.notAfter) {
    parts.push(`${daysLeft(certificate, hub.now())} ${pick(TEXT.days, language)}`);
  }
  return parts.join(' · ');
}

const moreRow = (count, language) => ({
  label: pick(TEXT.more, language),
  value: `+${count}`,
  icon: 'more-horizontal',
  color: WIDGET_COLORS.NEUTRAL,
});

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return message(TEXT.pick, language);
  }
  const states = new Map(selectSites(hub, settings).map((site) => [site, hub.stateOf(site)]));
  const sites = [...states.keys()].sort(
    (a, b) =>
      SEVERITY.indexOf(states.get(a)) - SEVERITY.indexOf(states.get(b)) ||
      a.name.localeCompare(b.name),
  );
  const shownSites = new Set(sites.map((site) => site.name));
  const down = hub
    .upstreamsDown()
    .filter((upstream) => upstream.sites.some((name) => shownSites.has(name)));
  if (sites.length === 0 && !hub.error) {
    return message(TEXT.empty, language);
  }

  const expiring = sites.filter((site) => states.get(site) === 'expiring').length;
  const working = sites.filter((site) => ['up', 'expiring'].includes(states.get(site))).length;
  const components = [
    {
      type: 'value',
      value: down.length,
      label: pick(TEXT.down, language),
      icon: 'x-circle',
      color: down.length > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: expiring,
      label: pick(TEXT.expiring, language),
      icon: 'lock',
      color: expiring > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: working,
      label: pick(TEXT.up, language),
      icon: 'check-circle',
      color: WIDGET_COLORS.SUCCESS,
    },
  ];

  if (hub.error) {
    components.push({
      type: 'text',
      variant: 'body',
      text: pick(ERROR_TEXT[hub.error.kind], language),
    });
  }

  if (sites.length > 0) {
    const shown = sites.length > MAX_ROWS ? sites.slice(0, MAX_ROWS - 1) : sites;
    const items = shown.map((site) => ({
      label: fit(site.name, 40),
      value: fit(rowValue(hub, site, language), 40),
      ...ROW_STYLE[states.get(site)],
    }));
    if (sites.length > shown.length) {
      items.push(moreRow(sites.length - shown.length, language));
    }
    components.push({ type: 'status', items });
  }

  if (down.length > 0) {
    const shown = down.length > MAX_UPSTREAM_ROWS ? down.slice(0, MAX_UPSTREAM_ROWS - 1) : down;
    const items = shown.map((upstream) => ({
      label: fit(upstream.address, 40),
      value: fit(upstream.sites.join(', ') || '-', 40),
      icon: 'x-circle',
      color: WIDGET_COLORS.DANGER,
    }));
    if (down.length > shown.length) {
      items.push(moreRow(down.length - shown.length, language));
    }
    components.push({ type: 'status', items });
  }

  components.push({
    type: 'button',
    label: pick(TEXT.refresh, language),
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: ACTIONS.REFRESH },
  });

  // Something broken moves: refresh sooner.
  const moving = hub.error || down.length > 0;
  return { ttl_seconds: moving ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollNow({ certificates: true });
  if (hub.error) {
    return { message: ERROR_TEXT[hub.error.kind] };
  }
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
