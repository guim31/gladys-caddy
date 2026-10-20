# Caddy

[Caddy](https://caddyserver.com) is the web server and reverse proxy in front
of many self-hosted services: it routes `cloud.example.com` to the Nextcloud
container, gets and renews the HTTPS certificates on its own, and can check
that each backend (upstream) still answers. This integration brings the state
of Caddy into Gladys: a "Caddy" device with its sites, the upstreams down and
the certificates expiring, and one device per site with the days left on its
certificate and its healthy upstreams. Scenes can react when **any** upstream
goes down or comes back, when a certificate is not renewed in time, or when
Caddy itself no longer answers; a dashboard widget lists the sites down first.

Tested against a real Caddy v2.11 (Docker, sites with `tls internal`, two
backends behind a health check, one stopped on purpose, a read-only site with
basic auth in front of the admin API). Feedback welcome on
[the issues](https://github.com/guim31/gladys-caddy/issues).

## What you need

- Gladys Assistant 5.1.0 or later.
- Caddy 2 with its **admin API** reachable from the Gladys machine (see below).
  By default Caddy serves it on `localhost:2019` only, on purpose: whoever
  reaches it can change the whole configuration.
- To know whether an upstream is **down**, a health check on its
  `reverse_proxy` (`health_uri`, active, or `fail_duration`, passive). Without
  one, Caddy counts every upstream healthy.
- The port of the HTTPS sites (443) reachable from Gladys, to read the
  certificates.

The integration sends three light requests per refresh interval (one minute
by default) to the admin API, and one TLS handshake per site and per hour to
read the certificates. Nothing goes to the internet, and nothing is ever
written to Caddy.

## Getting started

### 1. Make the admin API reachable

**Recommended: a read-only site.** Keep the admin API on `localhost:2019` and
add a site to your Caddyfile that only lets the three reads Gladys needs
through, behind a password (create the hash with
`caddy hash-password --plaintext 'your-password'`):

```
:2020 {
	@read {
		method GET
		path /config/ /reverse_proxy/upstreams /metrics
	}
	handle @read {
		basic_auth {
			gladys $2a$14$...the-hash...
		}
		reverse_proxy localhost:2019 {
			header_up Host localhost:2019
			header_up Origin http://localhost:2019
		}
	}
	respond 403
}
```

The two `header_up` lines are needed: without them the admin API refuses
proxied requests. Anything else (a `POST`, another path) gets a 403. This site
shows up as a site `:2020` in Gladys: leave it aside, or add it.

**Simpler, for a trusted network only:** `admin 0.0.0.0:2019` in the global
options of the Caddyfile. Anyone on the network can then change the
configuration of Caddy: restrict the port to the Gladys machine with a
firewall. With Docker, publish port 2019 (or 2020) of the Caddy container.

Note: the configuration read by Gladys may contain secrets (API tokens of a
DNS provider written in clear, password hashes). They are never stored,
logged or published by the integration, but whoever reaches the address can
read them: prefer `{env.…}` placeholders for such tokens.

### 2. Configure the integration

In Gladys, open **Integrations → Caddy → Configuration**:

- **Admin API address**: `http://192.168.1.2:2020` (read-only site) or
  `http://192.168.1.2:2019`. A bare `192.168.1.2` means port 2019.
- **User (basic auth)** and **Password (basic auth)**: those of the read-only
  site, if any.
- **Certificate host**: where the certificates are read, on the port of the
  HTTPS sites (443). Empty: the host of the API address, the usual case.
- **Refresh interval**: 30 seconds to 5 minutes.
- **Certificate alert (days)**: 14 by default, see "A certificate expires
  soon".
- **Language of the names**: language of the feature names and of the scene
  results.

Save, then **Test the connection**: the result shows the number of sites, the
upstreams down and the certificates expiring.

### 3. Add the devices

Open the **Discover** tab: the "Caddy" device and one device per site
(`cloud.example.com`…) are listed. Add the ones you want to follow. A site
block with several names (`a.example.com, b.example.com`) gives one device per
name. A site without certificate to read nor upstream (a wildcard serving
files) has no device.

## The devices

The **Caddy** device:

| Feature               | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| Reachable             | yes when the admin API answers, no after two failed reads     |
| Configuration loaded  | no when the last configuration load of Caddy failed           |
| Sites                 | sites (host names) in the configuration                       |
| Upstreams down        | upstreams failing their health checks                         |
| Certificates expiring | certificates under the alert threshold and late for a renewal |

Each **site**:

| Feature            | Value                                                            |
| ------------------ | ---------------------------------------------------------------- |
| Certificate expiry | days left before its certificate expires (HTTPS sites)           |
| Healthy upstreams  | upstreams of its `reverse_proxy` passing their health checks     |
| Upstreams in total | upstreams of its `reverse_proxy` (sites that proxy to a backend) |

Caddy has no way to tell its version through the admin API: it is not shown.
A site removed from the configuration while its device is in Gladys is shown
as missing, without upstream.

## Dashboard

Add the **Caddy** widget to a dashboard: the upstreams down, the certificates
expiring and the sites working, then one row per site — down first, then
degraded (some upstreams down), then the certificates expiring, then the
others — with its healthy upstreams and the days left on its certificate, and
the upstreams down with the sites they serve. Its settings can limit it to
some sites (devices added to Gladys). **Refresh** reads Caddy and every
certificate at once.

## Scenes

### Triggers

- **An upstream goes down**: an upstream fails its health checks, confirmed
  on two reads in a row (a restart of Caddy, which counts every upstream
  healthy until its first check, does not fire it). Variables: upstream
  address, sites served, recent failures.
- **An upstream is back up**: an upstream that was down passes its checks
  again. Variables: the same, and the length of the outage in minutes.
- **A certificate expires soon**: the certificate of a site has fewer days
  left than the alert threshold **and** Caddy is late renewing it (less than a
  fifth of its lifetime left; Caddy renews at a third). Short certificates
  (12 hours with `tls internal`) stay quiet as long as Caddy renews them. Once
  per certificate; optionally limited to some sites. Variables: site, days
  left, expiry date, issuer.
- **Caddy is unreachable**: the admin API no longer answers, two reads in a
  row. Variable: the reason.

Every upstream and site fires the triggers, added to Gladys or not. The
upstreams already down when the integration starts are not announced.

### Actions

- **State of a site**: healthy or not, its state in words (OK, Certificate
  expiring, Degraded, Down, Missing), healthy upstreams and in total, days
  left on the certificate, and a ready-made sentence such as
  "cloud.example.com: Degraded, 1/2 upstream(s) healthy, certificate valid 63
  more day(s)."
- **State of Caddy**: reachable or not, the number of sites, the number and
  addresses of the upstreams down, the sites with a certificate expiring, and
  a sentence. When Caddy does not answer, the action does not fail: it says
  so, and the scene goes on.

### Scene ideas

- When **An upstream goes down**, send a Telegram message "{{upstream}} is
  down ({{sites}})", and another one on **An upstream is back up** with the
  length of the outage.
- When **A certificate expires soon**, send a message "The certificate of
  {{site}} expires on {{expires_at}}": the renewal has failed, check the logs
  of Caddy (DNS, port 80 closed…).
- Every morning at 8:00, **State of Caddy** and, if something is wrong, read
  its sentence on the speaker.

## Troubleshooting

- **"Caddy does not answer"**: check the address and the port from the Gladys
  machine (`curl http://192.168.1.2:2020/config/ -u gladys`), and that the
  port is published by the Caddy container.
- **"access refused by Caddy"**: the admin API refused the request. Through a
  read-only site, check the two `header_up` lines; with `admin 0.0.0.0:2019`
  and `origins`, add the address Gladys uses.
- **"user or password refused"**: check the basic auth of the read-only site.
- **"no Caddy admin API at this address"**: the address points to a site that
  is not the admin API, or the read-only site does not let `/config/` through.
- **An upstream never goes down**: add a health check to its
  `reverse_proxy` (`health_uri /`).
- **No certificate days**: the certificates are read on port 443 of the
  certificate host; set **Certificate host** when Caddy is reached on another
  address. Wildcard sites and IP addresses are not read.
- More details in the logs of the integration (Integrations → Caddy → Logs),
  with `LOG_LEVEL=debug` for every read.

## Limits

- Read-only: nothing is ever written to Caddy.
- Caddy does not give its version through the admin API.
- Upstreams set by placeholders or dynamic upstreams are not followed.
- The certificates of wildcard sites (a probe name could trigger an on-demand
  issuance), IP addresses and sites without TLS are not read.
- The admin API itself over mutual TLS (`remote` admin) is not supported: use
  a read-only site.
- One Caddy per integration.
