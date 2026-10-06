---
title: "Data and privacy"
sidebar_label: "Data and privacy"
description: "What data the server stores, where, what is encrypted, which third parties are involved, and what is not yet provided."
---

# Data and privacy

This page lists **mechanisms and facts**. It is not a compliance statement; whether a given study complies
with GDPR depends on how it is run (legal basis, retention, processor agreements, hosting location).

## Where data lives

Everything is a file under the data folder, on your server; see [storage layout](./overview.md#storage-no-database).

| Data | Location | Encrypted at rest |
| --- | --- | --- |
| Responses | `studies/<id>/responses/*.csv` | No |
| Media (images, audio, keystroke logs) | `studies/<id>/media/` | No |
| Wearable measurements | `studies/<id>/.wearables_data/*.csv` | No |
| Wearable OAuth tokens | `studies/<id>/.wearables_tokens/` | **Yes** (libsodium `secretbox`), with plaintext fallback |
| Push subscriptions | `studies/<id>/.push_subscriptions/` | No |
| Provider client secrets, token key, VAPID private key | Server config file in `backend/config/` | **No** (plaintext, outside web root via `.htaccess`) |

## Third parties by design

| Party | What is sent |
| --- | --- |
| Browser push services (FCM, Mozilla, Apple) | Encrypted push payloads containing the study or questionnaire title and a short body. |
| Fitbit / Withings | OAuth exchange and API pulls, server to provider. |
| Google Fonts | The PWA's service worker fetches the Inter font. |

## Transport security

The application **does not enforce HTTPS**. TLS is expected from Apache's SSL module or, in the reference
deployment, a reverse proxy in front of the container. Push and service workers require HTTPS (or
localhost). The wearables redirect URI falls back to `http` if `$_SERVER['HTTPS']` is unset, so set
`wearables_redirect_uri` explicitly behind a proxy.

## Participant controls

| Control | Available |
| --- | --- |
| Informed-consent screen | Yes (study's `informedConsentForm`) |
| Decline notifications | Yes |
| Unsubscribe from push | Yes |
| Disconnect a wearable (deletes its token, data, cursor) | Yes |
| Sign out (clears local storage, IndexedDB, caches, service worker, push subscription) | Yes |
| Participant-initiated deletion of **response data** | <span className="status status--tbc">TBC</span> not provided |

## Researcher controls

CSV, media and wearable export; study backup; **Reset study** (wipes responses, statistics, media) and
delete study. Reset does not currently clear the wearables or push folders.

## Telemetry recorded without a separate consent step

- Push funnel events (sent, arrived, opened, failed).
- Client info: installed-as-PWA vs browser tab, and device class.
- The PWA stores the browser `userAgent` as a model string on each questionnaire event.

## Keystroke capture

The typing fallback records a **content-free event log** (letters are bucketed into classes, never stored as
characters) as a CSV, **and** the typed text itself in the `<name>~text` column. The log therefore does not
reveal text, but the response does.

## Not yet provided

<span className="status status--tbc">TBC</span> DPIA template, retention policy guidance, hardening
checklist, enforced HTTPS, removal or encryption of plaintext secrets in the server config, and a
participant-initiated data deletion path. Compliance documentation, including a DPIA, is **in progress**.
See [Current status](../current-status.md).
