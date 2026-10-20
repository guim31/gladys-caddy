// -----------------------------------------------------------------------------
// Certificates: the expiry date of the certificate Caddy serves for a site,
// read by a TLS handshake with the server of Caddy (SNI = the site name), the
// way a browser would. Only the public certificate is read: the private key
// never leaves Caddy, and nothing is sent after the handshake.
//
// The certificate is not verified: a site with `tls internal` (the local
// authority of Caddy) must be readable too, and an expired certificate is
// exactly what the integration must report.
// -----------------------------------------------------------------------------

import tls from 'node:tls';
import { isIP } from 'node:net';

export const DAY_MS = 24 * 3600_000;

/**
 * Whether the certificate of a site can be read: a plain host name, served
 * over TLS. Not a wildcard (any name under it could trigger an on-demand
 * issuance), an IP, a name without dot (`localhost`) or a listen address.
 */
export function readable(site) {
  const name = site.name;
  return (
    site.https &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(name) &&
    !isIP(name) &&
    !name.startsWith('*')
  );
}

/**
 * The one function that opens a TLS connection. The hub takes it as a
 * parameter: the tests replace it with in-memory certificates.
 * @returns {Promise<{ notBefore: number, notAfter: number, issuer: string }>}
 */
export function probeCertificate({ host, port, servername, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      const notBefore = Date.parse(certificate?.valid_from);
      const notAfter = Date.parse(certificate?.valid_to);
      if (!Number.isFinite(notAfter)) {
        reject(Object.assign(new Error('No certificate'), { code: 'NO_CERTIFICATE' }));
        return;
      }
      resolve({
        notBefore: Number.isFinite(notBefore) ? notBefore : notAfter,
        notAfter,
        issuer: String(certificate.issuer?.CN ?? certificate.issuer?.O ?? '').slice(0, 100),
      });
    });
    socket.once('timeout', () =>
      fail(Object.assign(new Error('TLS timeout'), { code: 'ETIMEDOUT' })),
    );
    socket.once('error', fail);
  });
}

/** Whole days left before the expiry (negative once expired). */
export const daysLeft = (certificate, now) => Math.floor((certificate.notAfter - now) / DAY_MS);

// Caddy renews a certificate when a third of its lifetime is left: under a
// fifth, the renewal is late.
export const LATE_RENEWAL_RATIO = 0.2;

/**
 * Whether a certificate counts as expiring: under `days` days left, and late
 * for its renewal. The second condition keeps short-lived certificates (12
 * hours for `tls internal`, 6 days for some ACME profiles), always under the
 * threshold, quiet as long as Caddy renews them.
 */
export function isExpiring(certificate, now, days) {
  const left = certificate.notAfter - now;
  const lifetime = Math.max(0, certificate.notAfter - certificate.notBefore);
  return left < days * DAY_MS && left < lifetime * LATE_RENEWAL_RATIO;
}
