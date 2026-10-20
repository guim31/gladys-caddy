# Caddy for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings the state of a [Caddy](https://caddyserver.com) web server into
Gladys: which sites have their backends up, which certificates Caddy failed to
renew, and whether Caddy itself is up.

- **A Caddy device**: reachable, configuration loaded, sites, upstreams down,
  certificates expiring.
- **One device per site** (`cloud.example.com`…): days left on its
  certificate, healthy upstreams and in total — from the health checks of
  Caddy.
- **Scene triggers**: an upstream goes down, is back up (with the outage
  length), a certificate expires soon and is late for renewal, Caddy is
  unreachable — for any upstream or site, added to Gladys or not.
- **Scene actions**: state of a site and state of Caddy, each with a
  ready-made sentence.
- **Dashboard widget**: sites down first, then degraded and certificates
  expiring, then the others, and the upstreams down.
- Texts in English, French, German and Spanish.

Tested against a real Caddy v2.11 (Docker, `tls internal` sites, two
`traefik/whoami` upstreams behind an active health check, one stopped on
purpose, a read-only site with basic auth in front of the admin API). Feedback
welcome on [the issues](https://github.com/guim31/gladys-caddy/issues).

## Requirements

- Gladys Assistant 5.1.0 or later.
- Caddy 2 with its admin API reachable from the Gladys machine: ideally
  through a read-only site of your Caddyfile that only lets `GET /config/`,
  `/reverse_proxy/upstreams` and `/metrics` through, behind basic auth (the
  recipe is in the [setup guide](docs/en.md)), or `admin 0.0.0.0:2019` on a
  trusted network.
- A health check on the `reverse_proxy` whose upstreams should be watched:
  without one, Caddy counts every upstream healthy.
- Port 443 of Caddy reachable from Gladys, to read the certificates.

## Installation

In Gladys, open **Integrations → Install from GitHub** and enter
`https://github.com/guim31/gladys-caddy`. Then open its configuration, enter
the address of the admin API (and the basic auth user and password if any),
and add the devices from the Discover tab.

The full guide: [docs/en.md](docs/en.md) (also in [French](docs/fr.md),
[German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

The container reads `GET /config/` (sites, listen ports, `reverse_proxy`
upstreams), `GET /reverse_proxy/upstreams` and `GET /metrics`
(`caddy_reverse_proxy_upstreams_healthy`, `caddy_config_last_reload_successful`)
at the chosen interval (every minute by default), and reads the certificate of
each HTTPS site once an hour by a TLS handshake on port 443 (SNI = the site
name). It publishes the states of the devices added to Gladys when they
change, and fires the scene events on the transitions, confirmed on two reads.
The last health of each upstream, the sites and the certificates already
announced are kept in `/data`, so a change during a restart is announced once.
Only `GET` requests are sent: nothing is ever written to Caddy.

## Limits

- Read-only.
- Caddy does not give its version through the admin API.
- Upstreams set by placeholders and dynamic upstreams are not followed.
- The certificates of wildcard sites, IP addresses and sites without TLS are
  not read.
- One Caddy per integration.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the notes on the Caddy
admin API.

## Credits

- [Caddy](https://github.com/caddyserver/caddy) by Matthew Holt and
  contributors (Apache-2.0): the API answers in `test/fixtures/caddy` come from
  its official Docker image, with
  [traefik/whoami](https://github.com/traefik/whoami) (Apache-2.0) as
  upstream.
- The Caddy logo on the cover comes from the
  [Caddy website repository](https://github.com/caddyserver/website), through
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Caddyserver_logo_light.svg)
  (public domain); Caddy is a registered trademark of its owner.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)
  and on the architecture of
  [gladys-traefik](https://github.com/guim31/gladys-traefik).

Not affiliated with Caddy, Matthew Holt or ZeroSSL.

## License

Apache-2.0, see [LICENSE](LICENSE).
