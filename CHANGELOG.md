### 🚀 Added

- Added option to specify y-axis minimum for charts.
- Added sensor-triggered prompts: in the trigger editor, an event trigger can fire when a Withings or Fitbit webhook reports new sleep, activity, weight, blood-pressure or ECG data, with an optional daily window, daily cap, delay and a time-of-day fallback. Needs the new `api/wearables_webhook.php` endpoint (see the Wearables docs). Not yet verified against live provider accounts. Fitbit's legacy Web API is scheduled to shut down on 2026-10-30; an experimental, untested placeholder for its successor, the Google Health API (webhook triggers only), is included; Google is not onboarding new projects, so it has never been run.

### ✏️ Changed

- Fixed missing item subkeys for chart variables.