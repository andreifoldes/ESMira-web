### 🚀 Added

- Added option to specify y-axis minimum for charts.
- Added sensor-triggered prompts: in the trigger editor, an event trigger can fire when a Withings or Fitbit webhook reports new sleep, activity, weight, blood-pressure or ECG data, with an optional daily window, daily cap, delay and a time-of-day fallback. Needs the new `api/wearables_webhook.php` endpoint (see the Wearables docs). Not yet verified against live provider accounts. Fitbit's legacy Web API is scheduled to shut down on 2026-10-30; an experimental, untested placeholder for its successor, the Google Health API (webhook triggers only), is included; Google is not onboarding new projects, so it has never been run.

- Participant app install flow, ported from the Sleep Diary prototype: the browser's install prompt is now captured before the app loads (so the **Install app** button reliably appears); iOS Safari and Chrome (v113+, iOS 16.4+) get matching Add to Home Screen steps and older iOS / Chrome / other iOS browsers get a clear update-or-switch alert instead of steps that can't work; links opened inside WhatsApp, Instagram, Mail and similar in-app browsers are steered to a real browser; desktop visitors can scan a QR code to continue on their phone; after installing, the app says to open it from the Home Screen (with a "can't see the app?" hint) and ticks off the funnel step; and iOS participants who arrived by invite link are shown their code to write down before installing.

### ✏️ Changed

- Fixed missing item subkeys for chart variables.