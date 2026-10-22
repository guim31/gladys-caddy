# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-22

### Security

- Rebuilt on Node.js 24.22.1, the October 2026 security release (remote code
  execution in the Brotli decoder, CVE-2026-111497; TLS hostname and DNS
  fixes).

## [1.0.0] - 2026-10-20

### Added

- A Caddy device: reachable, configuration loaded, sites, upstreams down,
  certificates expiring.
- One device per site of the configuration: days left on its certificate (read
  by a TLS handshake, `tls internal` included), healthy upstreams and in total,
  from the health checks of Caddy.
- Scene triggers: an upstream goes down, an upstream is back up (with the
  outage length), a certificate expires soon (under a threshold and late for
  its renewal), Caddy is unreachable.
- Scene actions: state of a site and state of Caddy, with a ready-made
  sentence.
- A dashboard widget: sites down first, certificates expiring, upstreams down,
  a Refresh button.
- Basic auth for a read-only site in front of the admin API, and a "Test the
  connection" action.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-caddy/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-caddy/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/guim31/gladys-caddy/releases/tag/v1.0.0
