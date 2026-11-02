#!/bin/sh
# certbot deploy hook for mqtt.test.kokoon.pixxo.io: copies the renewed cert to
# where the broker container reads it, with the container's mosquitto user
# (uid/gid 1883) as owner, then tells Mosquitto to reload it (SIGHUP; boards
# already connected stay connected). certbot runs this as root after every
# successful issue/renewal of the lineage it was registered with.
#
# Run it once by hand after the first `certbot certonly` (see DEPLOY.md).
set -eu

DOMAIN=mqtt.test.kokoon.pixxo.io
LIVE=${RENEWED_LINEAGE:-/etc/letsencrypt/live/$DOMAIN}
case "$LIVE" in
  */$DOMAIN) ;;
  *) exit 0 ;; # a different certificate was renewed
esac

DEST="$(cd "$(dirname "$0")" && pwd)/mosquitto/certs"
install -d -m 0750 -o 1883 -g 1883 "$DEST"
install -m 0644 -o 1883 -g 1883 "$LIVE/fullchain.pem" "$DEST/fullchain.pem"
install -m 0600 -o 1883 -g 1883 "$LIVE/privkey.pem" "$DEST/privkey.pem"

if docker ps --format '{{.Names}}' | grep -qx kokoon-iot-broker; then
  docker kill -s HUP kokoon-iot-broker >/dev/null
fi
