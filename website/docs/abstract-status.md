---
title: "Abstract vs. reality"
sidebar_label: "Abstract vs. reality"
description: "A claim-by-claim status of every feature promised in the iEMAbot abstract against what the code does today."
---

# Abstract vs. reality

This page takes each promise in the iEMAbot abstract and states, from the code, whether it is
<span className="status status--shipped">Shipped</span>, <span className="status status--partial">Partial</span> or
<span className="status status--tbc">TBC</span>. It was written by reading the repository, not the roadmap.

:::caution[Read this before citing the abstract]
Several abstract statements describe intended capabilities (Telegram delivery, wearable-triggered
prompts, event-contingent execution) that **do not exist in the code yet**. They are listed here as TBC
on purpose.
:::

## Summary table

| # | Abstract claim | Status | What the code does today |
| --- | --- | --- | --- |
| 1 | Open-source, low-cost, user-friendly alternative | <span className="status status--shipped">Shipped</span> | AGPL-3.0 code; self-hosted. Cost figure: see row 7. |
| 2 | Flexible delivery via a **custom web-based interface** | <span className="status status--shipped">Shipped</span> | The installable participant PWA, see [PWA overview](./pwa/overview.md). |
| 3 | Delivery via the **Telegram Bot API** | <span className="status status--tbc">TBC</span> | No Telegram code exists. See [Roadmap](./roadmap.md#telegram-bot-delivery). |
| 4 | Platform-agnostic architecture, extensible to **WhatsApp / SMS** | <span className="status status--tbc">TBC</span> | No channel-adapter layer. Web Push is the only server-initiated channel. See [Roadmap](./roadmap.md#additional-delivery-channels-whatsapp-sms). |
| 5 | Passive data from **Withings, Fitbit, Oura** via **OAuth 2.0** | <span className="status status--shipped">Shipped</span> | Full authorization-code flow, encrypted token store, hourly sync, CSV export. See [Wearables](./backend/wearables.md). |
| 6 | …used to **trigger or contextualize prompts in real time** | <span className="status status--tbc">TBC</span> | Wearable data is stored for researchers only. No code reads it to schedule or tailor a prompt; sync is hourly and lags by a day. See [Roadmap](./roadmap.md#wearable-triggered-and-contextualised-prompts). |
| 7 | Deployable on low-spec VPS for **under €10/month** | <span className="status status--partial">Partial</span> | One Docker container (PHP 8.3 + Apache), flat files, no database server, two cron jobs. No resource benchmarks or cost breakdown have been measured, so the € figure is unverified. See [Docker and cron](./deployment/docker-and-cron.md). |
| 8 | **Self-hosted**, full data control | <span className="status status--shipped">Shipped</span> | All data lives in a mounted volume on your server. Two third-party hops exist by design (browser push services; wearable provider APIs). See [Data and privacy](./backend/data-and-privacy.md). |
| 9 | **GDPR compliance** via encrypted channels | <span className="status status--partial">Partial</span> | Mechanisms exist (wearable tokens encrypted at rest; push payloads encrypted by the Web Push protocol; consent form; researcher export and study reset). HTTPS is expected from a reverse proxy but **not enforced in code**; plaintext secrets sit in the server config; no compliance documentation or DPIA exists. See [Data and privacy](./backend/data-and-privacy.md). |
| 10 | Web-based **management interface** for protocols | <span className="status status--shipped">Shipped</span> | ESMira's designer, plus fork-added Push and Wearables panels. See [Study model](./backend/study-model.md). |
| 11 | Flexible **"if-this-then-that" scheduling** | <span className="status status--partial">Partial</span> | Time-based schedules (fixed and random signal times) are executed. Event triggers can be *configured* in the designer but are **not executed** by the server push or the PWA. See [Scheduling](./backend/scheduling.md). |
| 12 | **Time-contingent** EMA designs | <span className="status status--shipped">Shipped</span> | Daily/weekday/day-of-month schedules, reminders, completion windows. |
| 13 | **Event-contingent** EMA designs | <span className="status status--tbc">TBC</span> | Designer UI only, see row 11. |
| 14 | **Adaptive** EMA designs | <span className="status status--tbc">TBC</span> | No adaptive scheduling logic. Per-question show-if conditions exist, but they branch within a questionnaire, not across prompts. |
| 15 | **Multi-point daily sampling** for diurnal trajectories | <span className="status status--shipped">Shipped</span> | Multiple signal times per day, random windows with a minimum gap, availability windows. |
| 16 | Surveys triggered by **wearable-detected wake-up times** | <span className="status status--tbc">TBC</span> | No wake-detection code. See row 6. |
| 17 | Capture of **cognition** across the day | <span className="status status--shipped">Shipped</span> | Embedded cognitive tasks (iframe + `postMessage`). The task pages themselves are hosted outside this repo. See [Cognitive tasks](./pwa/cognitive-tasks.md). |
| 18 | Engagement for **older / cognitively vulnerable** users | <span className="status status--partial">Partial</span> | Chat-style one-question-per-screen UI, text-size and contrast settings, image lightbox, automated WCAG 2.2 audit. No manual screen-reader pass and no usability study are documented. See [Accessibility](./pwa/accessibility.md). |
| 19 | **Dyadic EMA** (participant + caregiver) | <span className="status status--tbc">TBC</span> | No dyad/caregiver linking exists in the code. ESMira's random-group feature is unrelated. See [Roadmap](./roadmap.md#dyadic-ema). |
| 20 | **Openly documented**, designed for community extension | <span className="status status--partial">Partial</span> | This site is the first documentation. Upstream's plugin API is present; the fork has no contributor guide and no stable extension API of its own. |
| 21 | Proof-of-concept study | <span className="status status--tbc">TBC</span> | Not a software feature; no study results or protocol are documented here. |

## Detail on the partial and TBC rows

### Scheduling ("if-this-then-that")

ESMira models a *trigger* as `schedules` (times) or `eventTriggers` (cues such as "questionnaire
completed"), each with an action (invitation, message, notification). In this fork:

- <span className="status status--shipped">Shipped</span> **Schedules** are executed by
  `PushScheduler.php` (server Web Push) and mirrored client-side in `availability.ts`.
- <span className="status status--tbc">TBC</span> **Event triggers** are saved in the study JSON and editable
  in the designer, but no code in `src/backend`, `src/api`, `src/cli` or `web-pwa/src` fires them. Event
  execution is a behaviour of ESMira's *native* apps, which this repository does not contain.

Details and the exact cue list: [Scheduling](./backend/scheduling.md).

### Wearables

The pipeline ends at storage. Data flows *provider → server CSV → researcher download*. Nothing in the
notification scheduler, the availability logic, the survey engine or the service worker references wearable
data. Making wearables drive prompts would need (a) a sub-day sync cadence, (b) a wake-detection rule, and
(c) an event-trigger executor, none of which exist. See [Wearables](./backend/wearables.md).

### GDPR and encrypted channels

The abstract claims GDPR compliance "via encrypted channels". The honest reading of the code is:

| Mechanism | State |
| --- | --- |
| Data stays on the researcher's server | Yes (flat files in a volume). |
| Transport encryption | Delegated to the reverse proxy / Apache SSL; **not enforced** by application code. |
| Push payload encryption | Yes, by the Web Push protocol (`minishlink/web-push`). |
| Wearable token encryption at rest | Yes (libsodium `secretbox`), with a **plaintext fallback** if the key or extension is missing. |
| Provider client secrets / VAPID private key | Stored **in plaintext** in the server config file. |
| Informed consent | Yes, a study-level consent form is shown in the PWA. |
| Participant-initiated deletion of response data | **No.** Participants can disconnect wearables and unsubscribe push; researchers can reset or delete a study. |
| DPIA, retention policy, processor agreements | <span className="status status--tbc">TBC</span> |

Compliance is a property of how a study is run, not of the software alone. This project provides
building blocks; it does not make a legal claim. See [Data and privacy](./backend/data-and-privacy.md).
