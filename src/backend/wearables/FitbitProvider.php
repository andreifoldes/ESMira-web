<?php
declare(strict_types=1);

namespace backend\wearables;

/**
 * Fitbit OAuth2 provider. Port of iema-bot/src/wearables/fitbit.py.
 *
 * Quirks:
 *  - Token exchange and refresh use HTTP Basic auth (client_id:client_secret).
 *  - Refresh tokens are reusable, but a response may include a new one (persist it).
 *  - Intraday endpoints (1-min resolution) require special data access; we try them
 *    first and fall back to the daily summary on HTTP 403.
 */
class FitbitProvider extends WearablesProvider {
	const AUTH_URL  = 'https://www.fitbit.com/oauth2/authorize';
	const TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
	const API_BASE  = 'https://api.fitbit.com';
	const SCOPES    = 'activity heartrate sleep weight profile settings oxygen_saturation respiratory_rate temperature nutrition';

	public function key(): string { return 'fitbit'; }
	public function label(): string { return 'Fitbit'; }
	public function scopes(): string { return self::SCOPES; }
	public function dataTypes(): array {
		return ['activity', 'heartrate', 'sleep', 'weight', 'spo2', 'hrv', 'breathing_rate'];
	}

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
			'grant_type'   => 'authorization_code',
			'code'         => $code,
			'redirect_uri' => $redirectUri,
		], [$this->clientId, $this->clientSecret]);
		return $this->parseToken($resp);
	}

	public function refreshToken(string $refreshToken): array {
		$resp = WearablesHttp::postForm(self::TOKEN_URL, [
			'grant_type'    => 'refresh_token',
			'refresh_token' => $refreshToken,
		], [$this->clientId, $this->clientSecret]);
		return $this->parseToken($resp);
	}

	private function parseToken(array $resp): array {
		if($resp['status'] < 200 || $resp['status'] >= 300 || $resp['json'] === null)
			throw new WearablesException('Fitbit token request failed: ' . $resp['status'] . ' ' . substr($resp['body'], 0, 200));
		$json = $resp['json'];
		return $this->normalizeToken($json, (string) ($json['user_id'] ?? ''));
	}

	public function fetchData(string $accessToken, string $providerUserId, string $dataType, int $startMs, int $endMs): array {
		$rows = [];
		foreach($this->dateRange($startMs, $endMs) as $date) {
			$value = $this->fetchForDate($accessToken, $dataType, $date);
			if($value !== null)
				$rows[] = ['measurement_time' => $date, 'data_type' => $dataType, 'value' => $value];
		}
		return $rows;
	}

	/** @return mixed|null decoded payload for one date, or null when unsupported/empty */
	private function fetchForDate(string $token, string $dataType, string $date) {
		switch($dataType) {
			case 'activity':
				return $this->intradayWithFallback($token,
					self::API_BASE . "/1/user/-/activities/steps/date/$date/1d/1min.json",
					self::API_BASE . "/1/user/-/activities/date/$date.json");
			case 'heartrate':
				return $this->intradayWithFallback($token,
					self::API_BASE . "/1/user/-/activities/heart/date/$date/1d/1min.json",
					self::API_BASE . "/1/user/-/activities/heart/date/$date/1d.json");
			case 'hrv':
				return $this->intradayWithFallback($token,
					self::API_BASE . "/1/user/-/hrv/date/$date/all.json",
					self::API_BASE . "/1/user/-/hrv/date/$date.json");
			case 'spo2':
				return $this->intradayWithFallback($token,
					self::API_BASE . "/1/user/-/spo2/date/$date/all.json",
					self::API_BASE . "/1/user/-/spo2/date/$date.json");
			case 'breathing_rate':
				return $this->intradayWithFallback($token,
					self::API_BASE . "/1/user/-/br/date/$date/$date/all.json",
					self::API_BASE . "/1/user/-/br/date/$date.json");
			case 'sleep':
				$json = WearablesHttp::getBearerJson(self::API_BASE . "/1.2/user/-/sleep/date/$date.json", $token);
				return $json['sleep'] ?? [];
			case 'weight':
				$json = WearablesHttp::getBearerJson(self::API_BASE . "/1/user/-/body/log/weight/date/$date.json", $token);
				return $json['weight'] ?? [];
			default:
				return null;
		}
	}

	/** Try the intraday endpoint; on 403 fall back to the daily summary. */
	private function intradayWithFallback(string $token, string $intradayUrl, string $fallbackUrl) {
		$resp = WearablesHttp::getJson($intradayUrl, [], ['Authorization' => "Bearer $token"]);
		if($resp['status'] === 403)
			$resp = WearablesHttp::getJson($fallbackUrl, [], ['Authorization' => "Bearer $token"]);
		if($resp['status'] < 200 || $resp['status'] >= 300)
			throw new WearablesException("Fitbit fetch returned {$resp['status']}");
		return $resp['json'];
	}
}
