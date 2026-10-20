// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, site states, the "Test the connection" report,
// scene outputs. Four languages, the four of the Gladys interface; German
// says "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './caddy/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of the Caddy admin API in the configuration.',
    fr: "Saisissez l'adresse de l'API d'administration de Caddy dans la configuration.",
    de: 'Gib die Adresse der Admin-API von Caddy in der Konfiguration ein.',
    es: 'Introduzca la dirección de la API de administración de Caddy en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.2:2019',
    fr: 'Adresse incomprise, ex. http://192.168.1.2:2019',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.2:2019',
    es: 'Dirección no válida, p. ej. http://192.168.1.2:2019',
  },
};

// One short explanation per error kind (src/caddy/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'Caddy does not answer',
    fr: 'Caddy ne répond pas',
    de: 'Caddy antwortet nicht',
    es: 'Caddy no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: use an http:// address or a trusted certificate',
    fr: 'certificat refusé : utilisez une adresse http:// ou un certificat reconnu',
    de: 'Zertifikat abgelehnt: Nutze eine http://-Adresse oder ein vertrauenswürdiges Zertifikat',
    es: 'certificado rechazado: use una dirección http:// o un certificado reconocido',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'user or password refused',
    fr: 'utilisateur ou mot de passe refusé',
    de: 'Benutzer oder Passwort abgelehnt',
    es: 'usuario o contraseña rechazados',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'access refused by Caddy: check the origins of the admin API',
    fr: "accès refusé par Caddy : vérifiez les origins de l'API d'administration",
    de: 'Zugriff von Caddy verweigert: Prüfe die origins der Admin-API',
    es: 'acceso rechazado por Caddy: compruebe los origins de la API de administración',
  },
  [ERROR_KINDS.NOT_CADDY]: {
    en: 'no Caddy admin API at this address',
    fr: "pas d'API d'administration Caddy à cette adresse",
    de: 'keine Admin-API von Caddy unter dieser Adresse',
    es: 'no hay API de administración de Caddy en esta dirección',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The state of a site, in words (widget rows, scene outputs).
export const STATE_TEXT = {
  up: { en: 'OK', fr: 'OK', de: 'OK', es: 'OK' },
  expiring: {
    en: 'Certificate expiring',
    fr: 'Certificat à renouveler',
    de: 'Zertifikat läuft ab',
    es: 'Certificado por renovar',
  },
  degraded: { en: 'Degraded', fr: 'Dégradé', de: 'Eingeschränkt', es: 'Degradado' },
  down: { en: 'Down', fr: 'En panne', de: 'Ausgefallen', es: 'Caído' },
  missing: { en: 'Missing', fr: 'Absent', de: 'Fehlt', es: 'Ausente' },
};

// The "Test the connection" report and the sentences of the scene actions.
export const REPORT_TEXT = {
  en: {
    ok: 'Connected',
    sites: (count) => `${count} site(s)`,
    down: (count) => `${count} upstream(s) down`,
    expiring: (count) => `${count} certificate(s) expiring`,
    healthy: 'everything is fine',
    unreachable: 'Caddy does not answer',
  },
  fr: {
    ok: 'Connecté',
    sites: (count) => `${count} site(s)`,
    down: (count) => `${count} amont(s) en panne`,
    expiring: (count) => `${count} certificat(s) à renouveler`,
    healthy: 'tout va bien',
    unreachable: 'Caddy ne répond pas',
  },
  de: {
    ok: 'Verbunden',
    sites: (count) => `${count} Site(s)`,
    down: (count) => `${count} Upstream(s) ausgefallen`,
    expiring: (count) => `${count} Zertifikat(e) laufen ab`,
    healthy: 'alles in Ordnung',
    unreachable: 'Caddy antwortet nicht',
  },
  es: {
    ok: 'Conectado',
    sites: (count) => `${count} sitio(s)`,
    down: (count) => `${count} upstream(s) caído(s)`,
    expiring: (count) => `${count} certificado(s) por renovar`,
    healthy: 'todo está bien',
    unreachable: 'Caddy no responde',
  },
};

// Pieces of the `sentence` output of "State of a site".
export const SENTENCE_TEXT = {
  en: {
    upstreams: (up, total) => `${up}/${total} upstream(s) healthy`,
    days: (days) => (days < 0 ? 'certificate expired' : `certificate valid ${days} more day(s)`),
  },
  fr: {
    upstreams: (up, total) => `${up}/${total} amont(s) sain(s)`,
    days: (days) => (days < 0 ? 'certificat expiré' : `certificat valable encore ${days} jour(s)`),
  },
  de: {
    upstreams: (up, total) => `${up}/${total} Upstream(s) funktionsfähig`,
    days: (days) => (days < 0 ? 'Zertifikat abgelaufen' : `Zertifikat noch ${days} Tag(e) gültig`),
  },
  es: {
    upstreams: (up, total) => `${up}/${total} upstream(s) en buen estado`,
    days: (days) => (days < 0 ? 'certificado caducado' : `certificado válido ${days} día(s) más`),
  },
};

export const ACTION_TEXT = {
  unknownSite: {
    en: 'This device is not a Caddy site.',
    fr: "Cet appareil n'est pas un site Caddy.",
    de: 'Dieses Gerät ist keine Caddy-Site.',
    es: 'Este dispositivo no es un sitio de Caddy.',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
