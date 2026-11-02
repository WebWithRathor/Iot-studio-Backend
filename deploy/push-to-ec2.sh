#!/bin/sh
# Copies this backend's source to the EC2 box (this folder is not a git repo yet,
# so there is no `git pull` like the other backends). Server-only files are
# never sent and never deleted there: .env*, node_modules, dist, logs, the
# broker's broker.env, certs and board CA.
#
#   deploy/push-to-ec2.sh ec2-user@18.185.86.182        # or your ssh Host alias
#
# Then on the server: see "Update" in DEPLOY.md.
set -eu

TARGET=${1:?usage: deploy/push-to-ec2.sh <ssh-target, e.g. ec2-user@18.185.86.182>}
REMOTE_DIR=kokoon-iot-backend # relative to the ssh user's home

cd "$(dirname "$0")/.."
grep -q '"name": *"kokoon-backend"' package.json || { echo "not the IoT backend folder" >&2; exit 1; }

rsync -az --delete \
  --include '/.env.example' --exclude '/.env' --exclude '/.env.*' \
  --exclude '/node_modules/' --exclude '/dist/' --exclude '/logs/' --exclude '/coverage/' \
  --exclude '/deploy/broker.env' --exclude '/deploy/mosquitto/certs/' --exclude '/deploy/mosquitto/ca/' \
  --exclude '.DS_Store' \
  ./ "$TARGET:$REMOTE_DIR/"

echo "pushed to $TARGET:~/$REMOTE_DIR"
