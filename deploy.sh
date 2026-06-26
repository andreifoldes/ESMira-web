#!/usr/bin/env bash
set -euo pipefail

# Deploy ESMira (this fork — incl. the web-push backend) to a VPS.
#
# Usage: ./deploy.sh [HOST]      HOST defaults to surrey-vps.
#
# Unlike the upstream docker-compose (which pulls jodlidev/esmira:latest), this
# builds an image FROM THIS REPO's Dockerfile on the server, so our backend
# (api/push_*.php, backend/notifications/*, cli/*, composer web-push, cron) and
# the participant PWA are what actually run.
#
# Safe by design: data/config live in bind-mounted volumes that are never
# touched; the server docker-compose.yml is backed up before its image line is
# repointed. Rollback = restore the .bak compose and `docker compose up -d`.

HOST="${1:-surrey-vps}"
case "$HOST" in
  surrey-vps|rp-vms-iema-01)
    HOST="surrey-vps"
    REMOTE_DIR="/home/tf0011/esmira"
    ;;
  *)
    echo "Unknown host: $HOST" >&2
    echo "Valid hosts: surrey-vps" >&2
    exit 1
    ;;
esac

IMAGE="esmira-fork:latest"
CONTAINER_SVC="esmira"

echo "=== Building locally (webpack dist/ + participant PWA) ==="
# `prod` cleans dist/ and copies backend/api/cli/locales into it; build:pwa must
# run after (it writes dist/pwa). build:all does both in the right order.
npm run build:all

echo "=== Syncing Docker build context to $HOST:$REMOTE_DIR/build ==="
ssh "$HOST" "mkdir -p '$REMOTE_DIR/build'"
rsync -avz --delete \
  ./dist ./Dockerfile ./docker-entrypoint.sh \
  "$HOST:$REMOTE_DIR/build/"

echo "=== Syncing participant PWA into the bind-mounted pwa volume ==="
# The compose mounts ./esmira/pwa -> /var/www/html/pwa, so keep it current too.
rsync -avz --delete ./dist/pwa/ "$HOST:$REMOTE_DIR/esmira/pwa/"

echo "=== Building image on $HOST (composer install + cron baked in) ==="
ssh "$HOST" "cd '$REMOTE_DIR/build' && docker build -t '$IMAGE' ."

echo "=== Pointing docker-compose at the locally-built image (idempotent) ==="
ssh "$HOST" "cd '$REMOTE_DIR' \
  && if grep -q 'jodlidev/esmira:latest' docker-compose.yml; then \
       cp docker-compose.yml \"docker-compose.yml.bak.\$(date +%Y%m%d-%H%M%S)\"; \
       sed -i 's#image: jodlidev/esmira:latest#image: $IMAGE#' docker-compose.yml; \
       echo 'compose image repointed to $IMAGE (backup written)'; \
     else \
       echo 'compose already using a custom image'; \
     fi"

echo "=== Restarting via docker compose (data/config volumes preserved) ==="
ssh "$HOST" "cd '$REMOTE_DIR' && docker compose up -d"

echo "=== Ensuring a VAPID keypair exists (idempotent) ==="
ssh "$HOST" "cd '$REMOTE_DIR' && docker compose exec -T '$CONTAINER_SVC' php /var/www/html/cli/generate_vapid.php || true"

echo ""
echo "=== Container status + recent push-sender log ==="
ssh "$HOST" "cd '$REMOTE_DIR' && docker compose ps; echo '--- push log ---'; docker compose exec -T '$CONTAINER_SVC' sh -c 'tail -n 10 /var/log/esmira_push.log 2>/dev/null' || true"

echo ""
echo "=== Deploy complete ==="
