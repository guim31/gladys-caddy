# Caddy

[Caddy](https://caddyserver.com) ist der Webserver und Reverse Proxy vor
vielen selbst gehosteten Diensten: Er leitet `cloud.example.com` an den
Nextcloud-Container weiter, holt und erneuert die HTTPS-Zertifikate selbst und
kann prüfen, ob jedes Backend (Upstream) noch antwortet. Diese Integration
bringt den Zustand von Caddy in Gladys: ein Gerät „Caddy“ mit seinen Sites,
den ausgefallenen Upstreams und den ablaufenden Zertifikaten, und ein Gerät pro
Site mit den Resttagen ihres Zertifikats und ihren funktionierenden Upstreams.
Szenen können reagieren, wenn **irgendein** Upstream ausfällt oder
zurückkommt, wenn ein Zertifikat nicht rechtzeitig erneuert wird oder wenn
Caddy selbst nicht mehr antwortet; ein Dashboard-Widget zeigt die
ausgefallenen Sites zuerst.

Getestet mit einem echten Caddy v2.11 (Docker, Sites mit `tls internal`, zwei
Backends hinter einem Health Check, eines absichtlich gestoppt, eine
schreibgeschützte Site mit Basic Auth vor der Admin-API). Rückmeldungen sind
in [den Issues](https://github.com/guim31/gladys-caddy/issues) willkommen.

## Was du brauchst

- Gladys Assistant 5.1.0 oder neuer.
- Caddy 2 mit seiner **Admin-API**, erreichbar vom Gladys-Rechner (siehe
  unten). Standardmäßig stellt Caddy sie nur auf `localhost:2019` bereit, mit
  Absicht: Wer sie erreicht, kann die ganze Konfiguration ändern.
- Um zu wissen, ob ein Upstream **ausgefallen** ist, einen Health Check auf
  seinem `reverse_proxy` (`health_uri`, aktiv, oder `fail_duration`, passiv).
  Ohne ihn zählt Caddy jeden Upstream als funktionsfähig.
- Den Port der HTTPS-Sites (443) vom Gladys-Rechner aus erreichbar, um die
  Zertifikate zu lesen.

Die Integration sendet pro Aktualisierungsintervall (standardmäßig eine
Minute) drei leichte Anfragen an die Admin-API und einen TLS-Handshake pro
Site und Stunde, um die Zertifikate zu lesen. Nichts geht ins Internet, und
nichts wird je in Caddy geschrieben.

## Erste Schritte

### 1. Die Admin-API erreichbar machen

**Empfohlen: eine schreibgeschützte Site.** Lass die Admin-API auf
`localhost:2019` und füge deinem Caddyfile eine Site hinzu, die nur die drei
Lesezugriffe durchlässt, die Gladys braucht, hinter einem Passwort (den Hash
erzeugst du mit `caddy hash-password --plaintext 'dein-passwort'`):

```
:2020 {
	@read {
		method GET
		path /config/ /reverse_proxy/upstreams /metrics
	}
	handle @read {
		basic_auth {
			gladys $2a$14$...der-hash...
		}
		reverse_proxy localhost:2019 {
			header_up Host localhost:2019
			header_up Origin http://localhost:2019
		}
	}
	respond 403
}
```

Die zwei `header_up`-Zeilen sind nötig: Ohne sie lehnt die Admin-API
weitergeleitete Anfragen ab. Alles andere (ein `POST`, ein anderer Pfad)
bekommt ein 403. Diese Site erscheint in Gladys als Site `:2020`: Lass sie
beiseite oder lege sie an.

**Einfacher, nur in einem vertrauenswürdigen Netz:** `admin 0.0.0.0:2019` in
den globalen Optionen des Caddyfile. Dann kann jeder im Netz die Konfiguration
von Caddy ändern: Beschränke den Port per Firewall auf den Gladys-Rechner. Mit
Docker veröffentlichst du Port 2019 (oder 2020) des Caddy-Containers.

Hinweis: Die von Gladys gelesene Konfiguration kann Geheimnisse enthalten
(API-Tokens eines DNS-Anbieters im Klartext, Passwort-Hashes). Die Integration
speichert, protokolliert und veröffentlicht sie nie, aber wer die Adresse
erreicht, kann sie lesen: Nutze für solche Tokens lieber `{env.…}`.

### 2. Die Integration konfigurieren

Öffne in Gladys **Integrationen → Caddy → Konfiguration**:

- **Adresse der Admin-API**: `http://192.168.1.2:2020` (schreibgeschützte
  Site) oder `http://192.168.1.2:2019`. Ein einfaches `192.168.1.2` bedeutet
  Port 2019.
- **Benutzer (Basic Auth)** und **Passwort (Basic Auth)**: die der
  schreibgeschützten Site, falls vorhanden.
- **Host der Zertifikate**: wo die Zertifikate gelesen werden, auf dem Port der
  HTTPS-Sites (443). Leer: der Host der API-Adresse, der übliche Fall.
- **Aktualisierungsintervall**: 30 Sekunden bis 5 Minuten.
- **Zertifikatswarnung (Tage)**: standardmäßig 14, siehe „Ein Zertifikat läuft
  bald ab“.
- **Sprache der Namen**: Sprache der Funktionsnamen und der Szenen-Ergebnisse.

Speichere, dann **Verbindung testen**: Das Ergebnis zeigt die Zahl der Sites,
die ausgefallenen Upstreams und die ablaufenden Zertifikate.

### 3. Die Geräte anlegen

Öffne den Tab **Entdecken**: Das Gerät „Caddy“ und ein Gerät pro Site
(`cloud.example.com`…) werden aufgelistet. Lege die an, die du verfolgen
willst. Ein Site-Block mit mehreren Namen (`a.example.com, b.example.com`)
ergibt ein Gerät pro Name. Eine Site ohne lesbares Zertifikat und ohne
Upstream (ein Wildcard, das Dateien ausliefert) hat kein Gerät.

## Die Geräte

Das Gerät **Caddy**:

| Funktion               | Wert                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| Erreichbar             | ja, wenn die Admin-API antwortet, nein nach zwei Fehlschlägen      |
| Konfiguration geladen  | nein, wenn das letzte Laden der Konfiguration von Caddy fehlschlug |
| Sites                  | Sites (Hostnamen) der Konfiguration                                |
| Ausgefallene Upstreams | Upstreams, die ihre Health Checks nicht bestehen                   |
| Ablaufende Zertifikate | Zertifikate unter der Warnschwelle und mit verspäteter Erneuerung  |

Jede **Site**:

| Funktion                  | Wert                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| Ablauf des Zertifikats    | Tage bis zum Ablauf ihres Zertifikats (HTTPS-Sites)                      |
| Funktionierende Upstreams | Upstreams ihres `reverse_proxy`, die ihre Health Checks bestehen         |
| Upstreams insgesamt       | Upstreams ihres `reverse_proxy` (Sites, die an ein Backend weiterleiten) |

Caddy gibt seine Version über die Admin-API nicht preis: Deshalb wird sie nicht
angezeigt. Eine aus der Konfiguration entfernte Site, deren Gerät in Gladys
ist, wird als fehlend angezeigt, ohne Upstream.

## Dashboard

Füge das Widget **Caddy** einem Dashboard hinzu: die ausgefallenen Upstreams,
die ablaufenden Zertifikate und die funktionierenden Sites, dann eine Zeile
pro Site — erst ausgefallene, dann eingeschränkte (einige Upstreams aus), dann
ablaufende Zertifikate, dann die anderen — mit ihren funktionierenden
Upstreams und den Resttagen ihres Zertifikats, und die ausgefallenen Upstreams
mit den Sites, die sie bedienen. In seinen Einstellungen kannst du es auf
einige Sites beschränken (in Gladys angelegte Geräte). **Aktualisieren** liest
Caddy und alle Zertifikate sofort.

## Szenen

### Auslöser

- **Ein Upstream fällt aus**: Ein Upstream besteht seine Health Checks nicht,
  bestätigt in zwei Abfragen in Folge (ein Neustart von Caddy, das bis zur
  ersten Prüfung jeden Upstream als funktionsfähig zählt, löst ihn nicht aus).
  Variablen: Adresse des Upstreams, bediente Sites, letzte Fehlschläge.
- **Ein Upstream läuft wieder**: Ein ausgefallener Upstream besteht seine
  Prüfungen wieder. Variablen: dieselben und die Dauer des Ausfalls in Minuten.
- **Ein Zertifikat läuft bald ab**: Das Zertifikat einer Site hat weniger Tage
  übrig als die Warnschwelle **und** Caddy erneuert es verspätet (weniger als
  ein Fünftel seiner Laufzeit übrig; Caddy erneuert bei einem Drittel). Kurze
  Zertifikate (12 Stunden mit `tls internal`) bleiben still, solange Caddy sie
  erneuert. Einmal pro Zertifikat; auf einige Sites beschränkbar. Variablen:
  Site, verbleibende Tage, Ablaufdatum, Aussteller.
- **Caddy ist nicht erreichbar**: Die Admin-API antwortet nicht mehr, zwei
  Abfragen in Folge. Variable: der Grund.

Jeder Upstream und jede Site löst die Szenen aus, ob in Gladys angelegt oder
nicht. Upstreams, die beim Start der Integration schon ausgefallen sind,
werden nicht gemeldet.

### Aktionen

- **Zustand einer Site**: funktionsfähig oder nicht, ihr Zustand in Worten
  (OK, Zertifikat läuft ab, Eingeschränkt, Ausgefallen, Fehlt),
  funktionierende Upstreams und insgesamt, Resttage des Zertifikats und ein
  fertiger Satz wie „cloud.example.com: Eingeschränkt, 1/2 Upstream(s)
  funktionsfähig, Zertifikat noch 63 Tag(e) gültig.“
- **Zustand von Caddy**: erreichbar oder nicht, die Zahl der Sites, Zahl und
  Adressen der ausgefallenen Upstreams, die Sites mit ablaufendem Zertifikat
  und ein Satz. Antwortet Caddy nicht, schlägt die Aktion nicht fehl, sondern
  meldet es, und die Szene läuft weiter.

### Szenen-Ideen

- Bei **Ein Upstream fällt aus** eine Telegram-Nachricht „{{upstream}} ist
  ausgefallen ({{sites}})“ senden, und eine weitere bei **Ein Upstream läuft
  wieder** mit der Dauer des Ausfalls.
- Bei **Ein Zertifikat läuft bald ab** „Das Zertifikat von {{site}} läuft am
  {{expires_at}} ab“ senden: Die Erneuerung ist fehlgeschlagen, sieh in den
  Protokollen von Caddy nach (DNS, Port 80 zu…).
- Jeden Morgen um 8 Uhr **Zustand von Caddy** und, wenn etwas nicht stimmt,
  den Satz auf dem Lautsprecher vorlesen.

## Fehlerbehebung

- **„Caddy antwortet nicht“**: Prüfe Adresse und Port vom Gladys-Rechner aus
  (`curl http://192.168.1.2:2020/config/ -u gladys`) und ob der Port vom
  Caddy-Container veröffentlicht wird.
- **„Zugriff von Caddy verweigert“**: Die Admin-API hat die Anfrage abgelehnt.
  Über eine schreibgeschützte Site prüfe die zwei `header_up`-Zeilen; mit
  `admin 0.0.0.0:2019` und `origins` füge die Adresse hinzu, die Gladys nutzt.
- **„Benutzer oder Passwort abgelehnt“**: Prüfe die Basic Auth der
  schreibgeschützten Site.
- **„keine Admin-API von Caddy unter dieser Adresse“**: Die Adresse zeigt auf
  eine Site, die nicht die Admin-API ist, oder die schreibgeschützte Site lässt
  `/config/` nicht durch.
- **Ein Upstream fällt nie aus**: Füge seinem `reverse_proxy` einen Health
  Check hinzu (`health_uri /`).
- **Keine Zertifikatstage**: Die Zertifikate werden auf Port 443 des Hosts der
  Zertifikate gelesen; trage **Host der Zertifikate** ein, wenn Caddy über eine
  andere Adresse erreicht wird. Wildcard-Sites und IP-Adressen werden nicht
  gelesen.
- Mehr Details in den Protokollen der Integration (Integrationen → Caddy →
  Protokolle), mit `LOG_LEVEL=debug` für jede Abfrage.

## Grenzen

- Nur lesend: Es wird nie etwas in Caddy geschrieben.
- Caddy gibt seine Version über die Admin-API nicht preis.
- Upstreams aus Platzhaltern und dynamische Upstreams werden nicht verfolgt.
- Die Zertifikate von Wildcard-Sites (ein Testname könnte eine Ausstellung
  auf Abruf auslösen), IP-Adressen und Sites ohne TLS werden nicht gelesen.
- Die Admin-API selbst über gegenseitiges TLS (`remote`-Admin) wird nicht
  unterstützt: Nutze eine schreibgeschützte Site.
- Ein Caddy pro Integration.
