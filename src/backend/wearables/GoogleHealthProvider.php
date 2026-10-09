<?php
declare(strict_types=1);

namespace backend\wearables;

/**
 * Google Health API (successor of the Fitbit Web API, which Google turns off on 2026-10-30).
 *
 * EXPERIMENTAL - UNTESTED PLACEHOLDER. Written from Google's published documentation only and
 * never run against a live Google Cloud project, because Google was not onboarding new projects
 * when this was written. Expect to adjust it (scopes, notification shape, signature check) once
 * real access exists. Do not rely on it for a study.
 *
 * Differences from FitbitProvider that matter here:
 *  - Google OAuth 2.0: credentials go in the POST body, `access_type=offline` is needed for a
 *    refresh token, access tokens last 1 h, refresh tokens are reusable (the refresh response
 *    carries no new one, which WearablesTokenStore already tolerates).
 *  - The token response has no user id: users/me/identity is called right after the code
 *    exchange, and fails with ACCOUNT_NOT_LINKED when the Google Account has no Google Health
 *    profile (then we must not mark the participant as connected).
 *  - Webhooks use AUTOMATIC subscriptions registered once per server (see
 *    cli/wearables_setup.php googlehealth-webhook), so there is no per-participant subscribe call.
 *  - Only the trigger path is implemented: measurement data is not downloaded yet.
 */
class GoogleHealthProvider extends WearablesProvider {
	const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
	const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
	const IDENTITY_URL = 'https://health.googleapis.com/v4/users/me/identity';
	const SCOPE_PREFIX = 'https://www.googleapis.com/auth/googlehealth';
	// The scopes Google's webhook page associates with sleep, activity and weight notifications.
	const SCOPE_NAMES  = ['.sleep.readonly', '.activity_and_fitness.readonly', '.health_metrics_and_measurements.readonly'];

	public function key(): string { return 'googlehealth'; }
	public function label(): string { return 'Google Health'; }
	public function scopes(): string {
		return implode(' ', array_map(fn($name) => self::SCOPE_PREFIX . $name, self::SCOPE_NAMES));
	}
	/** Measurement download is not implemented; the hourly sync skips providers without data types. */
	public function dataTypes(): array { return []; }
	public function subscribesPerUser(): bool { return false; }

	public function getAuthUrl(string $state, string $redirectUri): string {
		return self::AUTH_URL . '?' . http_build_query([
			'response_type' => 'code',
			'client_id'     => $this->clientId,
			'redirect_uri'  => $redirectUri,
			'scope'         => $this->scopes(),
			'state'         => $state,
			'access_type'   => 'offline',
			'prompt'        => 'consent', // without it Google omits the refresh token on repeat consent
		]);
	}

	public function exchangeCode(string $code, string $redirectUri): array {
		$token = $this->requestToken([
			'grant_type'   => 'authorization_code',
			'code'         => $code,
			'redirect_uri' => $redirectUri,
		]);
		$token['provider_user_id'] = $this->fetchHealthUserId($token['access_token']);
		return $token;
	}

	public function refreshToken(string $refreshToken): array {
		return $this->requestToken([
			'grant_type'    => 'refresh_token',
			'refresh_token' => $refreshToken,
		]);
	}

	public function fetchData(string $accessToken, string $providerUserId, string $dataType, int $startMs, int $endMs): array {
		return [];
	}

	/** @throws WearablesException */
	private function requestToken(array $extra): array {
		$resp = WearablesHttp::postForm(self::TOKEN_URL, array_merge([
			'client_id'     => $this->clientId,
			'client_secret' => $this->clientSecret,
		], $extra));
		if($resp['status'] < 200 || $resp['status'] >= 300 || $resp['json'] === null || empty($resp['json']['access_token']))
			throw new WearablesException('Google token request failed: ' . $resp['status'] . ' ' . substr($resp['body'], 0, 200));
		return $this->normalizeToken($resp['json']);
	}

	/** @throws WearablesException when the Google Account has no Google Health profile or the call fails */
	private function fetchHealthUserId(string $accessToken): string {
		$resp = WearablesHttp::getJson(self::IDENTITY_URL, [], ['Authorization' => "Bearer $accessToken"]);
		if($resp['status'] < 200 || $resp['status'] >= 300) {
			$reason = $resp['json']['error']['details'][0]['reason'] ?? '';
			throw new WearablesException("Google Health identity lookup failed: {$resp['status']} $reason");
		}
		$id = (string) ($resp['json']['healthUserId'] ?? '');
		if($id === '')
			throw new WearablesException('Google Health identity response had no healthUserId');
		return $id;
	}
}
