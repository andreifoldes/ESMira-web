<?php
declare(strict_types=1);

namespace backend\wearables;

/**
 * Oura Ring OAuth2 provider. Port of iema-bot/src/wearables/oura.py.
 *
 * Quirks:
 *  - The token response has no user id, so after exchange we call
 *    /v2/usercollection/personal_info to obtain it.
 *  - Refresh tokens are SINGLE-USE — the new refresh_token must be persisted at once,
 *    and refresh does NOT return the user id (we keep the cached one).
 *  - Data endpoints are GET with date params (heartrate uses datetime params) and
 *    paginate via next_token.
 */
class OuraProvider extends WearablesProvider {
	const AUTH_URL  = 'https://cloud.ouraring.com/oauth/authorize';
	const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
	const API_BASE  = 'https://api.ouraring.com';
	const SCOPES    = 'daily heartrate workout session personal spo2 tag';

	public function key(): string { return 'oura'; }
	public function label(): string { return 'Oura Ring'; }
	public function scopes(): string { return self::SCOPES; }
	public function dataTypes(): array {
		return ['daily_sleep', 'daily_activity', 'daily_readiness', 'daily_spo2', 'sleep_detailed', 'heartrate', 'workout'];
	}

	/** internal data_type -> Oura API path */
	const PATHS = [
		'daily_sleep'     => 'daily_sleep',
		'daily_activity'  => 'daily_activity',
		'daily_readiness' => 'daily_readiness',
		'daily_spo2'      => 'daily_spo2',
		'daily_stress'    => 'daily_stress',
		'sleep_detailed'  => 'sleep',
		'sleep_time'      => 'sleep_time',
		'heartrate'       => 'heartrate',
		'workout'         => 'workout',
		'session'         => 'session',
		'tag'             => 'tag',
		'vo2_max'         => 'vo2_max',
	];

	public function getAuthUrl(string $state, string $redirectUri): string {
		return self::AUTH_URL . '?' . http_build_query([
			'response_type' => 'code',
			'client_id'     => $this->clientId,
			'redirect_uri'  => $redirectUri,
			'scope'         => self::SCOPES,
			'state'         => $state,
			'prompt'        => 'login',
		]);
	}

	public function exchangeCode(string $code, string $redirectUri): array {
		$resp = WearablesHttp::postForm(self::TOKEN_URL, [
			'grant_type'    => 'authorization_code',
			'client_id'     => $this->clientId,
			'client_secret' => $this->clientSecret,
			'code'          => $code,
			'redirect_uri'  => $redirectUri,
		]);
		if($resp['status'] < 200 || $resp['status'] >= 300 || $resp['json'] === null)
			throw new WearablesException('Oura token exchange failed: ' . $resp['status'] . ' ' . substr($resp['body'], 0, 200));
		$token = $this->normalizeToken($resp['json']);

		// Oura omits the user id from the token response — fetch it separately.
		try {
			$info = WearablesHttp::getBearerJson(self::API_BASE . '/v2/usercollection/personal_info', $token['access_token']);
			$token['provider_user_id'] = (string) ($info['id'] ?? '');
		}
		catch(WearablesException $e) { /* non-fatal: id stays empty */ }
		return $token;
	}

	public function refreshToken(string $refreshToken): array {
		$resp = WearablesHttp::postForm(self::TOKEN_URL, [
			'grant_type'    => 'refresh_token',
			'client_id'     => $this->clientId,
			'client_secret' => $this->clientSecret,
			'refresh_token' => $refreshToken,
		]);
		if($resp['status'] < 200 || $resp['status'] >= 300 || $resp['json'] === null)
			throw new WearablesException('Oura token refresh failed: ' . $resp['status'] . ' ' . substr($resp['body'], 0, 200));
		return $this->normalizeToken($resp['json']); // provider_user_id stays '' (kept by caller)
	}

	public function fetchData(string $accessToken, string $providerUserId, string $dataType, int $startMs, int $endMs): array {
		$path = self::PATHS[$dataType] ?? null;
		if($path === null)
			return [];
		$url = self::API_BASE . "/v2/usercollection/$path";

		if($path === 'heartrate')
			$params = [
				'start_datetime' => gmdate('Y-m-d\TH:i:s+00:00', intdiv($startMs, 1000)),
				'end_datetime'   => gmdate('Y-m-d\TH:i:s+00:00', intdiv($endMs, 1000)),
			];
		else
			$params = [
				'start_date' => gmdate('Y-m-d', intdiv($startMs, 1000)),
				'end_date'   => gmdate('Y-m-d', intdiv($endMs, 1000)),
			];

		$rows = [];
		$guard = 0;
		while($guard++ < 50) {
			$json = WearablesHttp::getBearerJson($url, $accessToken, $params);
			foreach(($json['data'] ?? []) as $item) {
				$t = $item['day'] ?? ($item['timestamp'] ?? '');
				$rows[] = ['measurement_time' => (string) $t, 'data_type' => $dataType, 'value' => $item];
			}
			$next = $json['next_token'] ?? null;
			if(empty($next))
				break;
			$params = ['next_token' => $next];
		}
		return $rows;
	}
}
