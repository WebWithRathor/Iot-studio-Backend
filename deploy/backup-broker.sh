#!/bin/sh
# Backs up the broker's state: dynamic-security.json (every board's login and
# ACL; losing it means re-uploading every board) and mosquitto.db (retained
# messages). Keeps KEEP_DAYS days locally; also uploads to BACKUP_S3_URI if set.
#
#   crontab -e  →  17 */6 * * * /home/ec2-user/kokoon-iot-backend/deploy/backup-broker.sh >> /home/ec2-user/backups/kokoon-iot-broker.log 2>&1
#
# Restore: see "Restore the broker" in DEPLOY.md.
set -eu

CONTAINER=${CONTAINER:-kokoon-iot-broker}
OUT=${BACKUP_DIR:-$HOME/backups/kokoon-iot-broker}
KEEP_DAYS=${KEEP_DAYS:-14}

mkdir -p "$OUT"
chmod 0700 "$OUT"
ts=$(date -u +%Y%m%dT%H%M%SZ)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

docker cp "$CONTAINER:/mosquitto/data/dynamic-security.json" "$tmp/dynamic-security.json"
# Absent until the first autosave (5 min after start)
docker cp "$CONTAINER:/mosquitto/data/mosquitto.db" "$tmp/mosquitto.db" 2>/dev/null || true

file="$OUT/broker-$ts.tgz"
(umask 077 && tar -C "$tmp" -czf "$file" .)
echo "$(date -u +%FT%TZ) wrote $file ($(wc -c < "$file") bytes)"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp --only-show-errors "$file" "${BACKUP_S3_URI%/}/broker-$ts.tgz"
fi

find "$OUT" -name 'broker-*.tgz' -type f -mtime +"$KEEP_DAYS" -delete
