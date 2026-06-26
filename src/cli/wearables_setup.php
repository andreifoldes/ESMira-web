<?php
// One-off server setup for wearables data sharing. Stores the *server-wide* OAuth app
// credentials for a provider (one app per provider per server) and generates the token
// encryption key on first use. CLI-only. Re-run per provider.
//
// Usage:
//   php cli/wearables_setup.php <fitbit|withings|oura> <client_id> <client_secret> [redirect_uri]
//   php cli/wearables_setup.php genkey            # only (re)generate the token key
//
// The optional redirect_uri overrides the auto-derived callback URL. Whatever you
// register with the provider must match: https://<your-server>/esmira/api/wearables_oauth.php

if(php_sapi_name() !== 'cli') {
	http_response_code(403);
	exit('This script is CLI-only.');
}

require_once dirname(__FILE__, 2) . '/backend/autoload.php';

use backend\Configs;
use backend\FileSystemBasics;
use backend\wearables\WearablesRegistry;

$args = array_slice($argv ?? [], 1);

/** Generate a base64 libsodium secretbox key (or 32 random bytes if sodium is absent). */
function makeTokenKey(): string {
	$raw = function_exists('sodium_crypto_secretbox_keygen')
		? sodium_crypto_secretbox_keygen()
		: random_bytes(32);
	return base64_encode($raw);
}

$config = [];
if(empty(Configs::get('wearables_token_key')))
	$config['wearables_token_key'] = makeTokenKey();

if(($args[0] ?? '') === 'genkey') {
	$config['wearables_token_key'] = makeTokenKey(); // force rotate
	FileSystemBasics::writeServerConfigs($config);
	fwrite(STDOUT, "Generated wearables token key.\n");
	if(!function_exists('sodium_crypto_secretbox'))
		fwrite(STDOUT, "WARNING: libsodium not available — tokens will be stored in plaintext.\n");
	exit(0);
}

if(count($args) < 3) {
	fwrite(STDERR, "Usage: php cli/wearables_setup.php <fitbit|withings|oura> <client_id> <client_secret> [redirect_uri]\n");
	fwrite(STDERR, "       php cli/wearables_setup.php genkey\n");
	exit(1);
}

[$provider, $clientId, $clientSecret] = $args;
$provider = strtolower($provider);
if(!WearablesRegistry::isKnown($provider)) {
	fwrite(STDERR, "Unknown provider '$provider'. Supported: " . implode(', ', array_keys(WearablesRegistry::PROVIDERS)) . "\n");
	exit(1);
}

$config["wearables_{$provider}_client_id"]     = $clientId;
$config["wearables_{$provider}_client_secret"] = $clientSecret;
if(isset($args[3]) && $args[3] !== '')
	$config['wearables_redirect_uri'] = $args[3];

FileSystemBasics::writeServerConfigs($config);

fwrite(STDOUT, "Configured wearables provider: $provider\n");
if(isset($config['wearables_token_key']))
	fwrite(STDOUT, "Generated wearables token key (encrypts stored tokens at rest).\n");
if(!function_exists('sodium_crypto_secretbox'))
	fwrite(STDOUT, "WARNING: libsodium not available — tokens will be stored in plaintext.\n");
$redirect = $config['wearables_redirect_uri'] ?? '<your-server>/esmira/api/wearables_oauth.php';
fwrite(STDOUT, "Register this redirect URI with $provider's developer console:\n  $redirect\n");
