/**
 * Automated WCAG 2.2 accessibility audit for the ESMira participant PWA.
 *
 * Serves the production build (dist/pwa) with `vite preview`, then drives it with
 * Playwright + axe-core through the participant journey — invite-code screen,
 * consent, name entry, the tutorial overview, and a practice run of every
 * questionnaire — running an axe scan (WCAG 2.0/2.1/2.2 A & AA) at each state, in
 * both the light and dark themes. Colour-contrast is checked against the actually
 * rendered colours, so both themes are covered.
 *
 * Question-type coverage: by default the audit runs against a fixture study
 * (fixtures/study-all-types.json) served via request interception, so every
 * renderable question type — likert, single/multiple choice, yes/no, free text,
 * number, time, duration, date, visual-analogue scale, voice memo, cognitive
 * task, and info/image — is exercised regardless of what the live study contains.
 * The fixture is the real `ssrc` study (its morning / momentary / evening bundle)
 * plus an injected "All Question Types" questionnaire, so the requested sample
 * bundle is audited too. Set A11Y_MODE=live to instead drive the real study over
 * the network (catches server-side drift; needs VPN/connectivity).
 *
 * Exit code: non-zero if any violation with an impact in A11Y_FAIL_ON
 * (default: critical,serious) is found — this is what gates a prod deploy.
 *
 * Env knobs:
 *   A11Y_MODE        fixture (default) | live
 *   A11Y_KEY         study invite code for live mode (default: ssrc)
 *   A11Y_PORT        vite preview port (default: 4318)
 *   A11Y_BASE_URL    audit an already-running server instead of spawning preview
 *   A11Y_FAIL_ON     comma list of impacts that fail the gate (default critical,serious)
 *   A11Y_THEMES      comma list of themes to audit (default light,dark)
 *   A11Y_LIVE_BUNDLE 1 = also walk morning/momentary/evening in every theme (slower)
 *   ESMIRA_PROXY     API proxy target for live mode (default from vite.config.ts)
 */

import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_PWA = resolve(__dirname, '..');

const MODE = process.env.A11Y_MODE || 'fixture';
const KEY = process.env.A11Y_KEY || 'ssrc';
const PORT = Number(process.env.A11Y_PORT || 4318);
const FAIL_ON = (process.env.A11Y_FAIL_ON || 'critical,serious').split(',').map((s) => s.trim()).filter(Boolean);
const THEMES = (process.env.A11Y_THEMES || 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BASE = (process.env.A11Y_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const APP_URL = (qs = '') => `${BASE}/pwa/${qs}`;

const FIXTURE = MODE === 'fixture'
  ? JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'study-all-types.json'), 'utf-8'))
  : null;

/** All violations collected across the run: {mode,theme,screen,id,impact,help,helpUrl,nodes}. */
const findings = [];
const auditedScreens = [];

// ── tiny helpers ────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function present(locator, timeout = 1200) {
  try { await locator.first().waitFor({ state: 'visible', timeout }); return true; } catch { return false; }
}
async function tryClick(locator, timeout = 1500) {
  try {
    if (await present(locator, timeout)) { await locator.first().click({ timeout: 8000 }); return true; }
  } catch { /* not clickable (e.g. stays disabled) — let the caller move on */ }
  return false;
}

/** Apply a theme by toggling the classes the app's CSS variants key off of. */
async function applyTheme(page, theme) {
  await page.evaluate((t) => {
    const c = document.documentElement.classList;
    c.remove('dark', 'high-contrast');
    if (t.includes('dark')) c.add('dark');
    if (t.includes('high-contrast')) c.add('high-contrast');
  }, theme);
}

/** Run one axe scan of the current DOM for a labelled screen, in the given theme. */
async function scan(page, screen, theme) {
  await applyTheme(page, theme);
  await sleep(120); // let transitions settle
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  auditedScreens.push(`${screen} [${theme}]`);
  for (const v of results.violations) {
    findings.push({
      mode: MODE, theme, screen,
      id: v.id, impact: v.impact || 'minor', help: v.help, helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: Array.isArray(n.target) ? n.target.join(' ') : String(n.target),
        html: (n.html || '').slice(0, 200),
        summary: (n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 300),
      })),
    });
  }
  const crit = results.violations.filter((v) => FAIL_ON.includes(v.impact)).length;
  log(`    · ${screen} [${theme}] — ${results.violations.length} violation(s)${crit ? `, ${crit} gating` : ''}`);
}

// ── preview server ──────────────────────────────────────────────────────────
// Spawned detached so teardown can signal the whole process group (npm parent +
// its vite child). A lingering vite grandchild on $PORT is what makes repeated
// runs flaky: the next run's --strictPort child exits immediately (port taken),
// but the stale server keeps answering the readiness probe, gets adopted, then
// dies mid-audit → ERR_CONNECTION_REFUSED. Group-kill + fail-fast close that gap.
let preview = null;
let previewExited = false;
async function startPreview() {
  if (process.env.A11Y_BASE_URL) { log(`▶ Using running server at ${BASE}`); return; }
  log(`▶ Starting vite preview on :${PORT} …`);
  previewExited = false;
  preview = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: WEB_PWA,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  preview.on('exit', (code) => {
    previewExited = true;
    if (code) process.stderr.write(`vite preview exited (code ${code})\n`);
  });
  preview.stdout.on('data', (d) => { if (/error/i.test(String(d))) process.stderr.write(d); });
  preview.stderr.on('data', (d) => process.stderr.write(d));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Our child exiting before it's ready almost always means $PORT is held by a
    // stale server — fail loudly instead of adopting it and crashing later.
    if (previewExited) throw new Error(`vite preview exited before becoming ready — is :${PORT} already in use?`);
    try { const r = await fetch(APP_URL()); if (r.ok) { log('  preview ready'); return; } } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('vite preview did not become ready within 60s');
}
function stopPreview() {
  if (!preview || previewExited) return;
  // Negative pid → signal the whole process group (npm parent + vite child), so
  // no vite grandchild survives to poison the next run.
  try { process.kill(-preview.pid, 'SIGTERM'); }
  catch { try { preview.kill('SIGTERM'); } catch { /* ignore */ } }
}

/** Restart the preview server if it has died (OOM, transient crash). No-op when
 *  auditing an externally-provided A11Y_BASE_URL — that server isn't ours. */
async function ensurePreview() {
  if (process.env.A11Y_BASE_URL) return;
  if (!preview || previewExited) {
    log('  ⚠ preview server is down — restarting …');
    await startPreview();
  }
}

/** page.goto with resilience to a transient loss of the preview server: on a
 *  network-level failure, make sure the server is up (restart if needed) and
 *  retry. A single blip mid-run must not abort an otherwise-clean audit. */
async function gotoApp(page, qs = '', opts = { waitUntil: 'domcontentloaded' }) {
  const url = APP_URL(qs);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await page.goto(url, opts); }
    catch (e) {
      lastErr = e;
      if (!/net::|ERR_CONNECTION|ERR_EMPTY_RESPONSE|ECONNREFUSED/i.test(String(e))) throw e;
      log(`  ⚠ navigation failed (attempt ${attempt}/3) for ${url}: ${String(e.message || e).split('\n')[0]}`);
      await ensurePreview();
      await sleep(500 * attempt);
    }
  }
  throw lastErr;
}

// ── request interception (fixture mode = fully offline & deterministic) ───────
async function installRouting(page) {
  if (MODE !== 'fixture') return;
  const body = JSON.stringify(FIXTURE);
  await page.route('**/esmira/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('studies.php')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    // Every other endpoint is best-effort in the app; answer benignly so the
    // audit needs no network and logs no failures.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":false}' });
  });
}

// ── journey ─────────────────────────────────────────────────────────────────

const readyBtn = (page) => page.getByRole('button', { name: /^I'm ready/ });

/**
 * Advance from a fresh mount to the tutorial overview, handling the onboarding
 * gates: informed consent → name entry → the mandatory notifications step
 * (push-enabled studies). Returning visits (state already settled) fast-path
 * straight to the tutorial.
 */
async function reachTutorial(page) {
  await gotoApp(page, `?key=${encodeURIComponent(KEY)}&tutorial=1`);
  if (await present(readyBtn(page), 3500)) return; // returning visit → already at tutorial
  await tryClick(page.getByRole('button', { name: 'I consent' }), 5000);
  if (await present(page.getByPlaceholder('Enter your name'), 3500)) {
    await page.getByPlaceholder('Enter your name').fill('Audit Tester');
    await page.getByRole('button', { name: 'Send' }).click();
  }
  // Mandatory notifications step: opt out to continue (headless can't grant push).
  await tryClick(page.getByRole('button', { name: 'Continue without notifications' }), 5000);
  await present(readyBtn(page), 8000);
}

/** One-time audit of the onboarding screens (consent, name, notifications), each
 *  in every theme via class-toggling, then leaves the app at the tutorial. */
async function auditOnboarding(page) {
  log(`\n▶ Auditing onboarding (consent → name → notifications)`);
  await gotoApp(page, `?key=${encodeURIComponent(KEY)}&tutorial=1`);
  if (await present(page.getByRole('button', { name: 'I consent' }), 6000)) {
    for (const theme of THEMES) await scan(page, 'consent', theme);
    await page.getByRole('button', { name: 'I consent' }).click();
  }
  if (await present(page.getByPlaceholder('Enter your name'), 4000)) {
    for (const theme of THEMES) await scan(page, 'name-entry', theme);
    await page.getByPlaceholder('Enter your name').fill('Audit Tester');
    await page.getByRole('button', { name: 'Send' }).click();
  }
  if (await present(page.getByRole('button', { name: 'Continue without notifications' }), 5000)) {
    for (const theme of THEMES) await scan(page, 'notifications-gate', theme);
    await page.getByRole('button', { name: 'Continue without notifications' }).click();
  }
  await present(readyBtn(page), 8000);
}

/** Audit the app-chrome modals (menu, settings + subpanels, details, contact). */
async function auditModals(page, theme) {
  const openMenu = () => tryClick(page.getByRole('button', { name: 'Quick actions' }), 4000);

  // Quick-actions grid menu
  if (await openMenu()) {
    await scan(page, 'menu', theme);
    // Settings modal (appearance) + its sub-panels
    if (await tryClick(page.getByRole('button', { name: 'Settings', exact: true }))) {
      await scan(page, 'settings-appearance', theme);
      const back = () => tryClick(page.getByRole('button', { name: 'Back' }));
      if (await tryClick(page.getByRole('button', { name: 'Send error report' }))) { await scan(page, 'settings-error-report', theme); await back(); }
      if (await tryClick(page.getByRole('button', { name: 'Notifications not working?' }))) { await scan(page, 'settings-notifications', theme); await back(); }
      if (await tryClick(page.getByRole('button', { name: 'Connect wearables' }))) { await scan(page, 'settings-wearables', theme); await back(); }
      if (await tryClick(page.getByRole('button', { name: 'About ESMira' }))) { await scan(page, 'settings-about', theme); }
      await tryClick(page.getByRole('button', { name: 'Close Settings' }));
    }
  }
  // Details / study-information modal
  if (await openMenu() && await tryClick(page.getByRole('button', { name: 'Details' }))) {
    await scan(page, 'details', theme);
    const back = () => tryClick(page.getByRole('button', { name: 'Back' }));
    if (await tryClick(page.getByRole('button', { name: 'Study description' }))) { await scan(page, 'details-description', theme); await back(); }
    if (await tryClick(page.getByRole('button', { name: 'Informed consent' }))) { await scan(page, 'details-consent', theme); await back(); }
    if (await tryClick(page.getByRole('button', { name: 'Upload protocol' }))) { await scan(page, 'details-protocol', theme); await back(); }
    await tryClick(page.getByRole('button', { name: 'Close', exact: true }));
  }
  // Contact modal
  if (await openMenu() && await tryClick(page.getByRole('button', { name: 'Contact' }))) {
    await scan(page, 'contact', theme);
    await tryClick(page.getByRole('button', { name: 'Close', exact: true }));
  }
}

/**
 * Answer whatever survey control is on screen, so the walk advances. Returns
 * false when no known control is present (questionnaire finished / stuck).
 */
async function advanceSurvey(page, theme, stepLabel) {
  const M = page.locator('main');
  // info card → Continue
  if (await present(M.getByRole('button', { name: 'Continue' }), 400)) { await M.getByRole('button', { name: 'Continue' }).click(); return true; }
  // voice-memo card → open recorder, audit it, close, then skip
  if (await present(M.getByRole('button', { name: 'Record voice memo' }), 400)) {
    await M.getByRole('button', { name: 'Record voice memo' }).click();
    if (await present(page.getByRole('dialog'), 3000)) { await scan(page, `${stepLabel}:recorder`, theme); }
    await tryClick(page.getByRole('button', { name: 'Close', exact: true }));
    return await tryClick(M.getByRole('button', { name: 'Skip' }), 1000);
  }
  // cognitive launch card → Skip (never open the external task iframe)
  if (await present(M.getByRole('button', { name: /^Start the/ }), 400)) {
    return await tryClick(M.getByRole('button', { name: 'Skip' }), 1000);
  }
  // multiple choice → pick one, then Done
  if (await present(M.locator('[role=group][aria-label="Select all that apply"]'), 400)) {
    await M.locator('[role=checkbox]').first().click();
    return await tryClick(M.getByRole('button', { name: 'Done' }));
  }
  // scale/choice/yes-no groups → click the first option
  for (const sel of ['[role=group][aria-label^="Rate from"]', '[role=group][aria-label="Yes or no"]', '[role=group][aria-label="Answer options"]']) {
    if (await present(M.locator(sel), 300)) { await M.locator(`${sel} button`).first().click(); return true; }
  }
  // number → fill + confirm
  if (await present(M.locator('input[type=number]'), 300)) {
    await M.locator('input[type=number]').fill('3');
    return await tryClick(page.getByRole('button', { name: 'Confirm' }));
  }
  // date → fill + confirm
  if (await present(M.locator('input[type=date]'), 300)) {
    await M.locator('input[type=date]').fill('2024-01-15');
    return await tryClick(page.getByRole('button', { name: 'Confirm' }));
  }
  // visual-analogue scale → set + confirm
  if (await present(M.locator('input[type=range]'), 300)) {
    await M.locator('input[type=range]').fill('70');
    return await tryClick(page.getByRole('button', { name: 'Confirm' }));
  }
  // time / duration → two selects + confirm
  const hour = M.locator('select[aria-label="Hour"], select[aria-label="Hours"]');
  const minute = M.locator('select[aria-label="Minute"], select[aria-label="Minutes"]');
  if (await present(hour, 300)) {
    // index 0 is the disabled placeholder; pick non-zero values so a duration
    // picker (which needs total ≥ 1 min) enables its Confirm button.
    await hour.first().selectOption({ index: 2 });
    if (await present(minute, 300)) await minute.first().selectOption({ index: 3 });
    return await tryClick(page.getByRole('button', { name: 'Confirm' }));
  }
  // free-text question → answer via the footer
  if (await present(page.getByPlaceholder('Type your response…'), 400)) {
    await page.getByPlaceholder('Type your response…').fill('A calm and productive day.');
    await page.getByRole('button', { name: 'Send' }).click();
    return true;
  }
  return false;
}

/** Start a practice run of one questionnaire and audit every question state. */
async function walkQuestionnaire(page, titleRe, label, theme, maxSteps = 24) {
  await reachTutorial(page);
  const practice = page.getByRole('button', { name: new RegExp(`practice run of .*${titleRe}`, 'i') });
  if (!await present(practice, 5000)) {
    const names = await page.getByRole('button', { name: /practice run of/i }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    log(`    ! could not find practice button for ${label} — available: ${JSON.stringify(names)}`);
    return;
  }
  await practice.first().click();
  for (let step = 1; step <= maxSteps; step++) {
    if (!await present(page.locator('main'), 2000)) break;
    // Stop when we've fallen back to the tutorial overview (practice complete).
    if (await present(readyBtn(page), 300)) break;
    await scan(page, `${label}:q${step}`, theme);
    if (!await advanceSurvey(page, theme, `${label}:q${step}`)) break;
    await sleep(180);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
function writeReport() {
  const outDir = resolve(__dirname, 'report');
  mkdirSync(outDir, { recursive: true });
  const gating = findings.filter((f) => FAIL_ON.includes(f.impact));
  const byImpact = (imp) => findings.filter((f) => f.impact === imp);
  const uniqRules = [...new Set(findings.map((f) => f.id))];

  writeReport.json = {
    mode: MODE, themes: THEMES, failOn: FAIL_ON,
    screensAudited: auditedScreens.length, screens: auditedScreens,
    totalViolations: findings.length, gatingViolations: gating.length,
    counts: { critical: byImpact('critical').length, serious: byImpact('serious').length, moderate: byImpact('moderate').length, minor: byImpact('minor').length },
    rules: uniqRules, findings,
  };
  writeFileSync(resolve(outDir, 'a11y-report.json'), JSON.stringify(writeReport.json, null, 2));

  // Markdown summary grouped by rule → screens.
  const lines = ['# ESMira PWA — accessibility audit', '',
    `- Mode: **${MODE}**  |  Themes: **${THEMES.join(', ')}**  |  Gate impacts: **${FAIL_ON.join(', ')}**`,
    `- Screens audited: **${auditedScreens.length}**`,
    `- Violations: **${findings.length}** total — 🔴 ${writeReport.json.counts.critical} critical, 🟠 ${writeReport.json.counts.serious} serious, 🟡 ${writeReport.json.counts.moderate} moderate, ⚪ ${writeReport.json.counts.minor} minor`,
    `- **Gate: ${gating.length ? `❌ FAIL (${gating.length} critical/serious)` : '✅ PASS'}**`, ''];
  const grouped = new Map();
  for (const f of findings) {
    const k = f.id;
    if (!grouped.has(k)) grouped.set(k, { impact: f.impact, help: f.help, helpUrl: f.helpUrl, hits: [] });
    grouped.get(k).hits.push(`${f.screen} [${f.theme}] × ${f.nodes.length}`);
  }
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  for (const [id, g] of [...grouped.entries()].sort((a, b) => order[a[1].impact] - order[b[1].impact])) {
    lines.push(`## ${g.impact.toUpperCase()} — \`${id}\``, `${g.help}  ([ref](${g.helpUrl}))`, '', ...g.hits.map((h) => `- ${h}`), '');
  }
  writeFileSync(resolve(outDir, 'a11y-report.md'), lines.join('\n'));
  log(`\n▶ Report written to a11y/report/a11y-report.{json,md}`);
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  await startPreview();
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    permissions: ['microphone'],
    // Audit the settled visual state: prefers-reduced-motion stops the app's
    // fade/scale entry animations, so axe measures final colours rather than a
    // mid-transition blend (which reads as a false contrast failure). Colours in
    // the settled full-motion state are identical.
    reducedMotion: 'reduce',
    // Block the app's service worker so (a) request interception (fixture mode)
    // actually intercepts the study fetch — the SW otherwise proxies it — and
    // (b) audits aren't served from a stale precache.
    serviceWorkers: 'block',
  });
  context.on('page', (p) => p.on('dialog', (d) => d.dismiss().catch(() => {})));
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await installRouting(page);

  try {
    log(`\n▶ Auditing invite-code screen`);
    await gotoApp(page);
    await present(page.getByRole('button', { name: 'Continue' }), 8000);
    for (const theme of THEMES) await scan(page, 'enter-code', theme);

    await auditOnboarding(page);

    for (const theme of THEMES) {
      log(`\n▶ Theme: ${theme}`);
      await reachTutorial(page);
      await scan(page, 'tutorial-overview', theme);
      await auditModals(page, theme);
      await walkQuestionnaire(page, 'All Question Types', 'all-types', theme);
      if (theme === THEMES[0] || process.env.A11Y_LIVE_BUNDLE === '1') {
        await walkQuestionnaire(page, 'Morning', 'morning', theme);
        await walkQuestionnaire(page, 'Momentary', 'momentary', theme);
        await walkQuestionnaire(page, 'Evening', 'evening', theme);
      }
    }
  } finally {
    await context.close();
    await browser.close();
    stopPreview();
  }

  writeReport();
  const gating = findings.filter((f) => FAIL_ON.includes(f.impact));
  const j = writeReport.json;
  log(`\n${'─'.repeat(60)}`);
  log(`Screens: ${j.screensAudited}  |  Violations: ${j.totalViolations}  (🔴 ${j.counts.critical} / 🟠 ${j.counts.serious} / 🟡 ${j.counts.moderate} / ⚪ ${j.counts.minor})`);
  if (gating.length) {
    log(`\n❌ Accessibility gate FAILED — ${gating.length} ${FAIL_ON.join('/')} violation node(s):`);
    const seen = new Set();
    for (const f of gating) {
      const k = `${f.id}@${f.screen}:${f.theme}`;
      if (seen.has(k)) continue; seen.add(k);
      log(`  • [${f.impact}] ${f.id} — ${f.screen} [${f.theme}] (${f.nodes.length} node${f.nodes.length > 1 ? 's' : ''})`);
    }
    process.exitCode = 1;
  } else {
    log(`\n✅ Accessibility gate PASSED — no ${FAIL_ON.join('/')} violations.`);
  }
})().catch((e) => {
  console.error('\n✖ Audit crashed:', e);
  stopPreview();
  process.exit(2);
});
