---
title: "Accessibility"
sidebar_label: "Accessibility"
description: "The PWA's accessibility features, the automated WCAG 2.2 audit that gates every deploy, and what has not yet been tested."
---

# Accessibility

<span className="status status--partial">Partial</span> Strong automated coverage; manual assistive-technology
testing is still to do.

The abstract highlights older and cognitively vulnerable participants. The design choices below target that,
but **no usability study with those groups is documented**.

## Design choices

- **Familiar interaction model:** a chat thread, one question per screen, a progress bar, plain wording.
- **Text size** up to *XX-Large*, a **high-contrast** theme, **dark mode**, and **reduce motion** (defaulting
  to the OS preference). Pinch-zoom is allowed (WCAG 1.4.4).
- **Image lightbox** and a **maximised prompt image** in recorder modals for picture tasks.
- **Fallbacks:** voice and typing alternatives, *Skip*, and *Change response*.
- **Semantics:** modal focus trap and Esc (`useDialogA11y`), an `aria-live` chat log, `lang="en"`.

## Automated audit

| Aspect | Detail |
| --- | --- |
| Tool | `axe-core` via `@axe-core/playwright`, Playwright Chromium (`web-pwa/a11y/audit.mjs`) |
| Standard | WCAG 2.0/2.1/2.2 **A and AA** tags |
| Viewport | 390 × 844, light and dark themes, reduced motion |
| Gate | Fails on **critical** or **serious** impacts (`A11Y_FAIL_ON`) |
| Fixture | `a11y/fixtures/study-all-types.json`: a sample study plus an "All Question Types" questionnaire (offline mode); a live mode also exists |
| Coverage | Invite, consent, name, notifications, tutorial, a practice run of every questionnaire, Settings and its panels, Details panels, Contact, the recorder modal |
| Latest result | 130 screens, 0 violations (report dated 4 Sep); `AUDIT.md` records 134 states, 0 issues |

Run it locally:

```bash
npm run a11y:setup   # one-off: installs the audit's dependencies
npm run a11y
```

`deploy.sh` runs the same audit as a **hard gate** before syncing (`A11Y_SKIP=1` bypasses it). A GitHub
workflow runs it on published releases and on manual dispatch, **not on every push**.

Fixes recorded in `AUDIT.md`: menu role changed to `group`, timestamp contrast, scrollable consent region made
focusable, focus-visible ring on the chat log, global `prefers-reduced-motion` CSS.

## Not covered

<span className="status status--tbc">TBC</span>

- Manual **VoiceOver / TalkBack** passes (recommended by the audit notes, not done).
- Automated coverage of the lightbox, keystroke modal, other-specify modal and wearables panel.
- The cognitive-task iframe (third-party content, deliberately skipped).
- **Likert buttons are 40 px**, under the 44 px recommended touch size, and scale anchor labels are one size
  smaller than body text.
- Usability testing with older adults or people with mild cognitive impairment.
