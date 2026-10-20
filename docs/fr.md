# Caddy

[Caddy](https://caddyserver.com) est le serveur web et reverse proxy placé
devant de nombreux services auto-hébergés : il envoie `cloud.example.com` vers
le conteneur Nextcloud, obtient et renouvelle seul les certificats HTTPS, et
peut vérifier que chaque serveur d'arrière-plan (amont, « upstream ») répond
encore. Cette intégration amène l'état de Caddy dans Gladys : un appareil
« Caddy » avec ses sites, les amonts en panne et les certificats à renouveler,
et un appareil par site avec les jours restants de son certificat et ses
amonts sains. Les scènes peuvent réagir quand **n'importe quel** amont tombe ou
revient, quand un certificat n'est pas renouvelé à temps, ou quand Caddy
lui-même ne répond plus ; un widget de tableau de bord liste d'abord les sites
en panne.

Testé avec un vrai Caddy v2.11 (Docker, sites en `tls internal`, deux serveurs
derrière un health check, dont un arrêté exprès, un site en lecture seule avec
basic auth devant l'API d'administration). Vos retours sont les bienvenus dans
[les issues](https://github.com/guim31/gladys-caddy/issues).

## Ce qu'il vous faut

- Gladys Assistant 5.1.0 ou plus récent.
- Caddy 2 avec son **API d'administration** joignable depuis la machine de
  Gladys (voir plus bas). Par défaut, Caddy ne la sert que sur
  `localhost:2019`, exprès : qui l'atteint peut changer toute la configuration.
- Pour savoir qu'un amont est **en panne**, un health check sur son
  `reverse_proxy` (`health_uri`, actif, ou `fail_duration`, passif). Sans lui,
  Caddy compte tous les amonts comme sains.
- Le port des sites HTTPS (443) joignable depuis Gladys, pour lire les
  certificats.

L'intégration envoie trois requêtes légères par intervalle de rafraîchissement
(une minute par défaut) à l'API d'administration, et une connexion TLS par site
et par heure pour lire les certificats. Rien ne part sur Internet, et rien
n'est jamais écrit dans Caddy.

## Pour commencer

### 1. Rendre l'API d'administration joignable

**Recommandé : un site en lecture seule.** Gardez l'API d'administration sur
`localhost:2019` et ajoutez à votre Caddyfile un site qui ne laisse passer que
les trois lectures dont Gladys a besoin, derrière un mot de passe (créez son
haché avec `caddy hash-password --plaintext 'votre-mot-de-passe'`) :

```
:2020 {
	@read {
		method GET
		path /config/ /reverse_proxy/upstreams /metrics
	}
	handle @read {
		basic_auth {
			gladys $2a$14$...le-haché...
		}
		reverse_proxy localhost:2019 {
			header_up Host localhost:2019
			header_up Origin http://localhost:2019
		}
	}
	respond 403
}
```

Les deux lignes `header_up` sont nécessaires : sans elles, l'API
d'administration refuse les requêtes relayées. Tout le reste (un `POST`, un
autre chemin) reçoit un 403. Ce site apparaît comme un site `:2020` dans
Gladys : laissez-le de côté, ou ajoutez-le.

**Plus simple, sur un réseau de confiance seulement :** `admin 0.0.0.0:2019`
dans les options globales du Caddyfile. N'importe qui sur le réseau peut alors
changer la configuration de Caddy : réservez le port à la machine de Gladys par
un pare-feu. Avec Docker, publiez le port 2019 (ou 2020) du conteneur Caddy.

À noter : la configuration lue par Gladys peut contenir des secrets (jetons
d'API d'un fournisseur DNS écrits en clair, hachés de mots de passe).
L'intégration ne les stocke, ne les journalise et ne les publie jamais, mais
qui atteint l'adresse peut les lire : préférez des `{env.…}` pour ces jetons.

### 2. Configurer l'intégration

Dans Gladys, ouvrez **Intégrations → Caddy → Configuration** :

- **Adresse de l'API d'administration** : `http://192.168.1.2:2020` (site en
  lecture seule) ou `http://192.168.1.2:2019`. Un simple `192.168.1.2` vaut
  port 2019.
- **Utilisateur (basic auth)** et **Mot de passe (basic auth)** : ceux du site
  en lecture seule, s'il y en a.
- **Hôte des certificats** : où lire les certificats, sur le port des sites
  HTTPS (443). Vide : l'hôte de l'adresse de l'API, le cas courant.
- **Intervalle de rafraîchissement** : de 30 secondes à 5 minutes.
- **Alerte certificat (jours)** : 14 par défaut, voir « Un certificat expire
  bientôt ».
- **Langue des noms** : langue des noms de fonctionnalités et des résultats de
  scène.

Enregistrez, puis **Tester la connexion** : le résultat donne le nombre de
sites, les amonts en panne et les certificats à renouveler.

### 3. Ajouter les appareils

Ouvrez l'onglet **Découverte** : l'appareil « Caddy » et un appareil par site
(`cloud.example.com`…) y sont listés. Ajoutez ceux que vous voulez suivre. Un
bloc de site à plusieurs noms (`a.example.com, b.example.com`) donne un
appareil par nom. Un site sans certificat à lire ni amont (un joker qui sert
des fichiers) n'a pas d'appareil.

## Les appareils

L'appareil **Caddy** :

| Fonctionnalité           | Valeur                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| Joignable                | oui quand l'API d'administration répond, non après deux échecs           |
| Configuration chargée    | non quand le dernier chargement de configuration de Caddy a échoué       |
| Sites                    | sites (noms d'hôte) de la configuration                                  |
| Amonts en panne          | amonts qui échouent à leurs health checks                                |
| Certificats à renouveler | certificats sous le seuil d'alerte et en retard pour leur renouvellement |

Chaque **site** :

| Fonctionnalité           | Valeur                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| Expiration du certificat | jours restants avant l'expiration de son certificat (sites HTTPS) |
| Amonts sains             | amonts de son `reverse_proxy` qui réussissent leurs health checks |
| Amonts au total          | amonts de son `reverse_proxy` (sites relayés vers un serveur)     |

Caddy ne donne pas sa version par l'API d'administration : elle n'est pas
affichée. Un site retiré de la configuration alors que son appareil est dans
Gladys apparaît comme absent, sans amont.

## Tableau de bord

Ajoutez le widget **Caddy** à un tableau de bord : les amonts en panne, les
certificats à renouveler et les sites qui fonctionnent, puis une ligne par
site — en panne d'abord, puis dégradés (une partie des amonts en panne), puis
les certificats à renouveler, puis les autres — avec ses amonts sains et les
jours restants de son certificat, et les amonts en panne avec les sites qu'ils
servent. Ses réglages peuvent le limiter à certains sites (appareils ajoutés à
Gladys). **Actualiser** relit Caddy et tous les certificats tout de suite.

## Scènes

### Déclencheurs

- **Un amont tombe en panne** : un amont échoue à ses health checks, confirmé
  sur deux lectures de suite (un redémarrage de Caddy, qui compte tous les
  amonts comme sains jusqu'à leur premier contrôle, ne le déclenche pas).
  Variables : adresse de l'amont, sites servis, échecs récents.
- **Un amont est rétabli** : un amont en panne réussit de nouveau ses
  contrôles. Variables : les mêmes, et la durée de la panne en minutes.
- **Un certificat expire bientôt** : le certificat d'un site a moins de jours
  devant lui que le seuil d'alerte **et** Caddy tarde à le renouveler (moins
  d'un cinquième de sa durée de vie restant ; Caddy renouvelle au tiers). Les
  certificats courts (12 heures en `tls internal`) restent silencieux tant que
  Caddy les renouvelle. Une fois par certificat ; limitable à certains sites.
  Variables : site, jours restants, date d'expiration, émetteur.
- **Caddy est injoignable** : l'API d'administration ne répond plus, deux
  lectures de suite. Variable : la raison.

Chaque amont et chaque site déclenche les scènes, ajouté à Gladys ou non. Les
amonts déjà en panne au démarrage de l'intégration ne sont pas annoncés.

### Actions

- **État d'un site** : en bonne santé ou non, son état en mots (OK, Certificat
  à renouveler, Dégradé, En panne, Absent), amonts sains et au total, jours
  restants du certificat, et une phrase toute prête comme
  « cloud.example.com : Dégradé, 1/2 amont(s) sain(s), certificat valable
  encore 63 jour(s). »
- **État de Caddy** : joignable ou non, le nombre de sites, le nombre et les
  adresses des amonts en panne, les sites au certificat à renouveler, et une
  phrase. Quand Caddy ne répond pas, l'action n'échoue pas : elle le dit, et
  la scène continue.

### Idées de scènes

- Sur **Un amont tombe en panne**, envoyer un message Telegram
  « {{upstream}} est en panne ({{sites}}) », et un autre sur **Un amont est
  rétabli** avec la durée de la panne.
- Sur **Un certificat expire bientôt**, envoyer « Le certificat de {{site}}
  expire le {{expires_at}} » : le renouvellement a échoué, regardez les logs de
  Caddy (DNS, port 80 fermé…).
- Chaque matin à 8 h, **État de Caddy** et, si quelque chose cloche, lire sa
  phrase sur l'enceinte.

## Dépannage

- **« Caddy ne répond pas »** : vérifiez l'adresse et le port depuis la machine
  de Gladys (`curl http://192.168.1.2:2020/config/ -u gladys`), et que le port
  est publié par le conteneur Caddy.
- **« accès refusé par Caddy »** : l'API d'administration a refusé la requête.
  Via un site en lecture seule, vérifiez les deux lignes `header_up` ; avec
  `admin 0.0.0.0:2019` et `origins`, ajoutez l'adresse qu'utilise Gladys.
- **« utilisateur ou mot de passe refusé »** : vérifiez la basic auth du site
  en lecture seule.
- **« pas d'API d'administration Caddy à cette adresse »** : l'adresse pointe
  vers un site qui n'est pas l'API d'administration, ou le site en lecture
  seule ne laisse pas passer `/config/`.
- **Un amont ne tombe jamais en panne** : ajoutez un health check à son
  `reverse_proxy` (`health_uri /`).
- **Pas de jours de certificat** : les certificats sont lus sur le port 443 de
  l'hôte des certificats ; renseignez **Hôte des certificats** quand Caddy est
  joint par une autre adresse. Les sites jokers et les adresses IP ne sont pas
  lus.
- Plus de détails dans les logs de l'intégration (Intégrations → Caddy →
  Logs), avec `LOG_LEVEL=debug` pour chaque lecture.

## Limites

- Lecture seule : rien n'est jamais écrit dans Caddy.
- Caddy ne donne pas sa version par l'API d'administration.
- Les amonts définis par des placeholders et les amonts dynamiques ne sont pas
  suivis.
- Les certificats des sites jokers (un nom de sonde pourrait déclencher une
  émission à la demande), des adresses IP et des sites sans TLS ne sont pas
  lus.
- L'API d'administration elle-même en TLS mutuel (admin `remote`) n'est pas
  prise en charge : utilisez un site en lecture seule.
- Un seul Caddy par intégration.
