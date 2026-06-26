<?php
declare(strict_types=1);

namespace backend\wearables;

use backend\Configs;

/**
 * Knows the supported providers and resolves the server-wide OAuth app credentials
 * (configured once per server via cli/wearables_setup.php, like the VAPID keys).
 *
 * Server config keys per provider slug `<p>`:
 *   wearables_<p>_client_id, wearables_<p>_client_secret
 * Plus optionally `wearables_redirect_uri` (overrides the auto-derived callback URL).
 */
class WearablesRegistry {
	const PROVIDERS = [
		'fitbit'   => FitbitProvider::class,
		'withings' => WithingsProvider::class,
		'oura'     => OuraProvider::class,
	];

	public static function isKnown(string $name): bool {
		return isset(self::PROVIDERS[$name]);
	}

	/** @return array{client_id:string, client_secret:string}|null */
	public static function credentials(string $name): ?array {
		if(!self::isKnown($name))
			return null;
		$id     = (string) Configs::get("wearables_{$name}_client_id");
		$secret = (string) Configs::get("wearables_{$name}_client_secret");
		if($id === '' || $secret === '')
			return null;
		return ['client_id' => $id, 'client_secret' => $secret];
	}

	/** Instantiate a configured provider, or null if unknown / no server credentials. */
	public static function get(string $name): ?WearablesProvider {
		$creds = self::credentials($name);
		if($creds === null)
			return null;
		$class = self::PROVIDERS[$name];
		return new $class($creds['client_id'], $creds['client_secret']);
	}

	/** Provider slugs that have server credentials configured (offered to the PWA). */
	public static function configuredProviders(): array {
		$out = [];
		foreach(array_keys(self::PROVIDERS) as $name) {
			if(self::credentials($name) !== null)
				$out[] = $name;
		}
		return $out;
	}

	/**
	 * The OAuth redirect URI (must match what is registered with each provider). Uses
	 * `wearables_redirect_uri` if configured, else derives it from the current request:
	 * scheme://host + the /api/ directory + wearables_oauth.php.
	 */
	public static function redirectUri(): string {
		$configured = (string) Configs::get('wearables_redirect_uri');
		if($configured !== '')
			return $configured;
		$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
		$host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
		$dir    = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/api/x.php')), '/');
		return "$scheme://$host$dir/wearables_oauth.php";
	}
}
