# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- the optional **basic auth user and password** of the read-only site serving
  the admin API of Caddy, stored by Gladys in the integration configuration
  (never written to `/data`, never logged); they are only sent, in the
  `Authorization` header, to the address configured, and redirects are not
  followed so they never reach another host;
- the answer of `/config/`, the whole running configuration of Caddy (it may
  include secrets: DNS provider tokens, password hashes): kept in memory, only
  the site names, listen ports and upstream addresses are used, published to
  Gladys or logged;
- the admin API can change the configuration of Caddy: the integration only
  ever sends `GET` requests to `/config/`, `/reverse_proxy/upstreams` and
  `/metrics`, and the documentation recommends a read-only site in front of
  the API rather than exposing it;
- the certificates: one TLS handshake per site with the server of Caddy, to
  read the expiry date of the public certificate; nothing is sent after the
  handshake, and the certificate is not trusted for anything else;
- `/data/caddy-state.json`: the address of the admin API, the sites (names,
  ports, upstream addresses), the last health of each upstream and since when,
  the expiry dates already announced (no secret);
- network: HTTP(S) requests to the admin API address and TLS connections to
  the certificate host, nothing else; no port is opened.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and Caddy itself.
