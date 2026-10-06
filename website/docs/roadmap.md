---
title: "Roadmap and TBC items"
sidebar_label: "Roadmap / TBC"
description: "Placeholders for features promised in the abstract that are not implemented yet, with what is missing for each."
---

# Roadmap and TBC items

Everything on this page is <span className="status status--tbc">TBC</span>: **not implemented in the
repository today.** Each section records what the abstract promises, what exists nearby, and what would
need to be built. No dates are committed.

:::note
This page is deliberately a set of placeholders. When a feature ships, move it into the relevant
documentation page and flip its badge in [Current status](./current-status.md).
:::

## Telegram bot delivery {/* #telegram-bot-delivery */}

- **Abstract:** "flexible delivery via … the Telegram Bot API".
- **Today:** no Telegram code anywhere in `src/`, `web-pwa/` or `tools/`.
- **Nearest existing piece:** Web Push ([Web Push](./backend/web-push.md)) is the only server-initiated channel.
- **Missing:** a bot token and webhook, a way to bind a Telegram chat to a participant/study, a message
  renderer for each [question type](./pwa/question-types.md), and a channel-neutral dispatcher.

_Placeholder: design notes TBC._

## Additional delivery channels (WhatsApp, SMS) {/* #additional-delivery-channels-whatsapp-sms */}

- **Abstract:** "platform-agnostic architecture allows for future extension to services like WhatsApp and SMS".
- **Today:** no channel-adapter abstraction. `PushSender` talks to the Web Push library directly.
- **Missing:** an interface that `PushScheduler` output can be fed into regardless of channel, and
  per-channel delivery receipts (today's funnel is *sent / arrived / opened / failed* for Web Push only).

_Placeholder: adapter interface TBC._

## Wearable-triggered and contextualised prompts {/* #wearable-triggered-and-contextualised-prompts */}

- **Abstract:** wearable data used "to trigger or contextualize prompts in real time", including surveys
  "based on wearable-detected wake-up times".
- **Today:** wearable data is ingested and exported only. Searches of the notification, availability,
  survey-engine and service-worker code found no reference to wearable data.
- **Constraints in the current design:** the sync is an hourly cron job that fetches only *completed UTC
  days up to yesterday*, so data is at best hours old and usually a day old.
- **Missing:**
  1. a sub-day sync (or provider webhooks) for sleep sessions,
  2. a wake-time detection rule per provider,
  3. an event-trigger executor ([below](#event-contingent-execution)) so a detected wake can schedule a prompt,
  4. a researcher UI to configure it.

_Placeholder: wake-detection specification TBC._

## Event-contingent execution {/* #event-contingent-execution */}

- **Abstract:** "if-this-then-that" rules enabling "event-contingent, and adaptive EMA designs".
- **Today:** the designer can save event triggers (cue dropdown, delay, source-questionnaire filter), but the
  server push scheduler explicitly skips event-triggered questionnaires and the PWA has no executor.
  See [Scheduling](./backend/scheduling.md#event-triggers).
- **Missing:** an executor that evaluates cues server-side (or in the service worker) and enqueues the
  configured action; and, for *adaptive* designs, conditions over previous answers or external signals.

_Placeholder: executor design TBC._

## Dyadic EMA {/* #dyadic-ema */}

- **Abstract:** "planned application in dyadic EMA research … in people with mild cognitive impairment
  and their caregivers".
- **Today:** no code links two participants. ESMira's *random groups* assign a participant to a study arm;
  they do not pair people.
- **Missing:** a pairing/invite mechanism, role-specific questionnaires, and joint export.

_Placeholder: dyad data model TBC._

## Cost and capacity figures {/* #cost-and-capacity-figures */}

- **Abstract:** deployable for "under €10/month" on low-spec VPS.
- **Today:** the stack is light (one container, flat files), but no load test, memory profile or participant
  capacity estimate has been recorded.
- **Missing:** a measured reference configuration (vCPU, RAM, disk) and the number of concurrent
  participants it sustains with Web Push and hourly wearable sync enabled.

_Placeholder: benchmark TBC._

## Compliance documentation {/* #compliance-documentation */}

- **Abstract:** "full data control and GDPR compliance via encrypted channels".
- **Today:** technical mechanisms exist ([Data and privacy](./backend/data-and-privacy.md)). Compliance
  documentation, including a DPIA, is **in progress**; a DPIA template, retention guidance and a hardening
  checklist are not yet published.
- **Missing:** documentation for operators, enforced HTTPS, encryption or removal of plaintext secrets in
  the server config, and a participant-initiated data-deletion path.

_Placeholder: operator checklist TBC._

## Extension guide {/* #extension-guide */}

- **Abstract:** "designed for community extension".
- **Today:** upstream's plugin API exists; the fork adds no documented extension points.
- **Missing:** a contributor guide, a documented provider interface for new wearables
  (`WearablesProvider` is the natural seam), and test coverage for the backend additions.

_Placeholder: contributor guide TBC._

## Smaller known gaps found while documenting

These are verified defects or limitations rather than abstract promises:

| Item | Detail |
| --- | --- |
| Welcome-push outcome not recorded | `push_event.php` accepts `welcome_confirmed` / `welcome_missed`, but `PushEvents` only persists `sent`, `failed`, `received`, `clicked`, so these never reach the researcher panel. |
| Once-per-day limit is client-enforced | `completableOncePerDay` is enforced by the PWA and its service worker, not rejected by the server's dataset ingest. |
| Wearable provider list edge case | An empty `wearablesProviders` list means "all allowed" to the server but "none offered" to the PWA. |
| No provider-side token revocation | Disconnecting deletes local token, data and cursor, but does not revoke the token at Fitbit or Withings. |
| Data-type selector has no UI | `wearablesDataTypes` can only be set by editing the study source. |
| `maxLength` / `minLength` have no designer field | They exist on inputs but are only settable via the study source. |
| Appearance settings do not persist | Dark mode, contrast and text size reset on reload (in-memory state). |
| Likert buttons are 40 px | Below the 44 px recommended touch size. |
