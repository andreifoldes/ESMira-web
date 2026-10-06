---
title: "Cognitive tasks"
sidebar_label: "Cognitive tasks"
description: "How browser-based cognitive tasks (m2c2kit and similar) are embedded in surveys, how results return, and the cache-busting rules."
---

# Cognitive tasks

<span className="status status--shipped">Shipped</span> embedding and capture ·
<span className="status status--partial">Partial</span> the task pages themselves are **not in this repo**

Diurnal variation in cognition is a core use case. The PWA embeds web-based tasks directly in a survey so a
participant never leaves the app.

## The `webapp` input

A first-class `webapp` response type carries a launch `url`, a title (`text`) and a `webappDescription`.
(Legacy: a plain text item containing an `<a href>` is also treated as a cognitive task.)

```mermaid
sequenceDiagram
  participant S as Survey card
  participant F as Full-screen iframe
  participant T as Hosted task page
  S->>F: open url + "embed=1&v=N"
  F->>T: load task
  T-->>S: postMessage {type: "m2c2:complete", summary, data}
  S->>S: check origin matches iframe URL
  S->>S: store summary in item column, trial rows in hidden questionnaire
```

- The launch URL gets **`embed=1&v=N`** appended. Keep the stored URL **clean**: the adapter adds those
  parameters.
- The iframe is full-screen with `autoplay`, `fullscreen`, `accelerometer` and `gyroscope` allowed.
- Completion arrives as `postMessage` `{type: 'm2c2:complete', summary, data}`; the origin is checked against
  the iframe URL. The participant sees only **"✓ Completed"**, with no performance feedback.
- Each task offers **Start** and **Skip**.

## What is stored

| Where | Content |
| --- | --- |
| The item's own column | Summary JSON `{session, n_trials, duration_s, correct_count}` |
| A hidden questionnaire titled **"Cognitive Trials"** | One row per trial: `cogAssessment`, `cogSource`, `cogInputName`, `cogSession`, `cogTrialIndex`, `cogRt`, `cogCorrect`, `cogResponse`, `cogStimulus`, `cogRaw` |

If the hidden questionnaire does not exist in the study, no per-trial rows are written. Whether it exists in
a given deployment is something to confirm per study.

## Tasks used in the fixtures

Color Shapes, Symbol Search, Prices, a brief Psychomotor Vigilance Test (PVT-BA) and the Affective Slider.
The wrapper pages are served from a separate host (under `/webapp/…`); this repository holds only the
integration.

## Cache-busting rule

The wrapper chain loads `index.html?v=N` → `index.js?v=N` → `task.js?v=N`. The `v=N` value is set **in
`esmiraAdapter.ts`**, and the PWA emits `embed=1&v=N` itself. Consequences:

:::warning[A committed version bump does nothing on its own]
Changing `N` has no effect until the **PWA is rebuilt and redeployed**, because the value is baked into the
bundle. Participants with an installed PWA also need the service worker to update.
:::

Related: the PVT instruction screen defaults `show_tutorial` to true.

## Accessibility note

The cognitive iframe is deliberately **excluded** from the automated accessibility audit, since the content
is third-party task code. See [Accessibility](./accessibility.md).
