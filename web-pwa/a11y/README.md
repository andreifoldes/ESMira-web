# Participant PWA — automated accessibility audit

Automated **WCAG 2.2 A/AA** audit of the ESMira participant PWA, using
[axe-core](https://github.com/dequelabs/axe-core) driven by Playwright. It serves
the real production build (`dist/pwa`) with `vite preview` and walks the whole
participant journey — invite code → consent → name → the mandatory notifications
step → the tutorial → a practice run of **every questionnaire** — running an axe
scan at each state, in both the **light** and **dark** themes.

This is the same check that gates a production deploy (see `deploy.sh`).

## What it covers

- **Every renderable question type**, via a fixture study
  (`fixtures/study-all-types.json`) served through request interception: likert,
  single- & multiple-choice, yes/no, free text, number, time, duration, date,
  visual-analogue scale, voice memo (recorder modal included), cognitive-task
  launch card, and info/image. The fixture is the real `ssrc` sample study (its
  morning / momentary / evening bundle) **plus** an injected "All Question Types"
  questionnaire, so the sample bundle is exercised too.
- **Both themes**, so colour-contrast is checked against the actually rendered
  colours in day and night mode.
- **All the app chrome**: onboarding screens, the quick-actions menu, Settings
  and its sub-panels, the Details/study-info modal, Contact, and the recorder.

Colour-contrast is measured on the *settled* UI: the audit runs with
`prefers-reduced-motion`, so axe never samples a mid-fade blend.

## Run it

```bash
# one-time: install axe + Playwright + Chromium
npm install            # (or `npm run a11y:setup` from the repo root)

# build the PWA first (the audit serves dist/pwa), then audit
(cd .. && npm run build)
node audit.mjs         # (or `npm run a11y` from the repo root, after a build)
```

Exit code is non-zero if any **critical** or **serious** violation is found.
A human-readable summary and the full machine-readable results are written to
`report/a11y-report.md` and `report/a11y-report.json`.

## Modes & knobs (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `A11Y_MODE` | `fixture` | `fixture` = offline, deterministic, all question types. `live` = drive the real study over the network (needs VPN/connectivity; catches server drift). |
| `A11Y_KEY` | `ssrc` | Study invite code used in `live` mode. |
| `A11Y_FAIL_ON` | `critical,serious` | Impact levels that fail the gate. |
| `A11Y_THEMES` | `light,dark` | Themes to audit. |
| `A11Y_LIVE_BUNDLE` | – | `1` = walk morning/momentary/evening in *every* theme (slower). |
| `A11Y_PORT` | `4318` | Port for the spawned `vite preview`. |
| `A11Y_BASE_URL` | – | Audit an already-running server instead of spawning preview. |
| `ESMIRA_PROXY` | (vite default) | API proxy target for `live` mode. |

## In the deploy pipeline

`deploy.sh` runs this audit right after `npm run build:all` and before anything
is synced to the server; a critical/serious violation aborts the deploy. Set
`A11Y_SKIP=1` to bypass it in an emergency. CI runs the same audit at release
time (`.github/workflows/accessibility.yml`, on a published GitHub release or
on demand) — deploy.sh remains the day-to-day enforcement.
