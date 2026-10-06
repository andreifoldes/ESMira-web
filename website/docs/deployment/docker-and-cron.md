---
title: "Docker and cron"
sidebar_label: "Docker and cron"
description: "The container image, its PHP extensions, the two cron jobs, volumes, and what a host needs to run the fork."
---

# Docker and cron

<span className="status status--shipped">Shipped</span> · cost and capacity figures are
<span className="status status--tbc">TBC</span> (see [Roadmap](../roadmap.md#cost-and-capacity-figures))

The fork ships as a **single container** built from the repository's `Dockerfile`. There is no separate
database, queue or worker service: ESMira is flat-file, and the background jobs run as cron inside the same
container.

## What the image contains

| Layer | Detail |
| --- | --- |
| Base | `php:8.3.10-apache` |
| PHP extensions | `zip`, `gmp`, `mbstring`, `curl`, `sodium` |
| Why | `gmp`, `mbstring`, `curl` for `minishlink/web-push` (VAPID signing, payload encryption, HTTP client); `sodium` encrypts stored wearable tokens |
| App files | `COPY ./dist /var/www/html`, so the ESMira webpack build **and** the PWA (`dist/pwa/`) must exist before `docker build` |
| Composer | `composer update --no-dev` in `backend/` installs web-push into `backend/vendor` |
| Apache | `rewrite`, `md`, `ssl` modules enabled; production `php.ini` |

## Cron jobs

Both use the **absolute** PHP path, because cron's minimal `PATH` excludes `/usr/local/bin` and a bare `php`
fails with "php: not found", silently, so the sender would never run.

| Schedule | Command | Log |
| --- | --- | --- |
| Every minute | `/usr/local/bin/php /var/www/html/cli/push_send_due.php` | `/var/log/esmira_push.log` |
| Hourly (`0 * * * *`) | `/usr/local/bin/php /var/www/html/cli/wearables_sync.php` | `/var/log/esmira_wearables.log` |

`docker-entrypoint.sh` fixes volume ownership, runs the storage migrations (`MigrationManager::autoRun()`),
starts cron, then runs Apache in the foreground. The researcher panel's **sender heartbeat** warns if the
push job has not run for more than 180 s.

## Volumes

| Mount | Holds |
| --- | --- |
| `backend/config/` | Server config, including VAPID keys, wearable client secrets and the token key |
| `esmira_data/` | All studies, responses, media, tokens |
| `/etc/apache2/sites-enabled/` | Apache vhosts |

Back up `esmira_data/` **and** `backend/config/`. Losing the token key makes stored wearable tokens
unreadable; rotating the VAPID keys invalidates every push subscription.

## First-time setup

```bash
# inside the container (as www-data)
php cli/generate_vapid.php                     # Web Push keys
php cli/wearables_setup.php genkey             # wearable token key
php cli/wearables_setup.php fitbit <id> <secret>   # repeat per provider
```

Then register the redirect URI shown in the study's **Wearables** panel with each provider.

## Host requirements

- Docker with the Compose plugin.
- **HTTPS in front of the container.** Service workers and Web Push need a secure origin, and the app does
  not enforce TLS itself (see [Data and privacy](../backend/data-and-privacy.md#transport-security)).
  Terminate TLS in Apache or in a reverse proxy; when proxying, set `wearables_redirect_uri` explicitly.
- Outbound HTTPS to browser push services and, if used, the wearable providers.
- Serve `/pwa/` (static) next to the ESMira API root.

:::note[The repo's `docker-compose.yml` is upstream's]
It references the upstream image and has no mount for `/pwa/`. The fork's production compose file is not in
the repository.
:::

## Local development

```bash
npm install && npm run prod          # ESMira build (cleans dist/)
cd web-pwa && npm install && npm run dev   # PWA dev server on :5174, proxies /esmira/api
```

Point the proxy at a local ESMira with `ESMIRA_PROXY=http://localhost:8081`.
