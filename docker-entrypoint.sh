#!/bin/sh

# Making sure php has write permission for volume folders
chown -R www-data:www-data /var/www/html/backend/config/
chown -R www-data:www-data /var/www/html/esmira_data

# Docker image could have been updated, so we check for migrations:
php -r "require_once '/var/www/html/backend/autoload.php'; backend\MigrationManager::autoRun();"

# Start cron, which runs the web-push sender every minute (cli/push_send_due.php).
service cron start 2>/dev/null || cron || true

# Running passed entry point:
exec "$@"