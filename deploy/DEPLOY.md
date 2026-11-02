# IoT Studio: test-environment deploy

Everything runs next to the existing Kokoon backends on the EC2 box
`18.185.86.182` (eu-central-1, `ec2-user`, nginx 1.30 in front). The frontend is
on S3 + CloudFront, like the classroom.

| Piece | Where | Address |
|---|---|---|
| IoT API | global pm2 `kokoon-iot-backend`, `~/kokoon-iot-backend`, `127.0.0.1:4004` | `https://api.iot.test.kokoon.pixxo.io/api/v1` via nginx |
| MQTT broker | Docker container `kokoon-iot-broker` (Mosquitto 2.0.22 + dynsec) | `mqtts://mqtt.test.kokoon.pixxo.io:8883` (TLS only) |
| IoT frontend | S3 bucket + CloudFront | `https://iot.test.kokoon.pixxo.io` |
| Mongo / Redis | existing Atlas cluster, database `kokoon-iot` / existing Redis Cloud, prefix `kokoon-iot:` | — |

Files in this folder:

- `docker-compose.broker.yml`, `broker.env.example`, `mosquitto/mosquitto.prod.conf`: the broker.
- `nginx/kokoon-iot.http.conf` (stage 1) and `nginx/kokoon-iot.conf` (final): the nginx config.
- `certbot-mqtt-deploy-hook.sh`: copies the broker's certificate in and reloads it.
- `backup-broker.sh`: backs up broker accounts and retained messages.
- `push-to-ec2.sh`: copies the code to the server.
- `../../Kokoon Frontend/scripts/deploy-s3.sh`: publishes the frontend.

Run `$` commands on your Mac and `ec2$` commands on the server.

---

## 1. Before you start

1. **Fill in `Kokoon Backend/.env.production`** (on your Mac; it becomes the server's `.env`):
   - `PORT=4004` and `HOST=127.0.0.1` (only nginx should reach the API).
   - `MONGODB_URI`: the existing Atlas cluster's URI with database `/kokoon-iot`.
     The box already reaches that cluster, so the Atlas IP list needs no change.
   - `REDIS_URL`: the existing Redis Cloud URL. `REDIS_KEY_PREFIX=kokoon-iot:` keeps keys apart.
   - Razorpay: test-mode keys (`rzp_test_…`) and a webhook secret. Production mode refuses to start without them.
   - Leave the `mqtts://mqtt.test.kokoon.pixxo.io:8883` URLs as they are.
2. **DNS** (whoever runs `pixxo.io`):
   - `api.iot.test.kokoon.pixxo.io` CNAME → `ec2-18-185-86-182.eu-central-1.compute.amazonaws.com`
   - `mqtt.test.kokoon.pixxo.io` CNAME → `ec2-18-185-86-182.eu-central-1.compute.amazonaws.com`
   - `iot.test.kokoon.pixxo.io` CNAME → the CloudFront domain from step 8.
3. **EC2 security group**: allow inbound TCP **8883** from `0.0.0.0/0`. Do not open 1883 or 4004.
4. **Check the server** has Node ≥ 20.11 (`node -v`), Docker with the compose plugin
   (`docker compose version`) and certbot (`certbot --version`). On Amazon Linux 2023:
   `sudo dnf install -y docker certbot && sudo systemctl enable --now docker && sudo usermod -aG docker ec2-user`,
   then log in again. The compose plugin comes from Docker's own instructions for AL2023.

## 2. Code and settings onto the server

```bash
deploy/push-to-ec2.sh ec2-user@18.185.86.182
scp .env.production ec2-user@18.185.86.182:kokoon-iot-backend/.env
```

```bash
ec2$ chmod 600 ~/kokoon-iot-backend/.env
ec2$ cd ~/kokoon-iot-backend/deploy && cp broker.env.example broker.env && chmod 600 broker.env
ec2$ nano broker.env        # MQTT_ADMIN_PASSWORD = MQTT_PASSWORD from ../.env
```

## 3. Certificates

```bash
ec2$ sudo mkdir -p /var/www/certbot
ec2$ sudo cp ~/kokoon-iot-backend/deploy/nginx/kokoon-iot.http.conf /etc/nginx/conf.d/kokoon-iot.conf
ec2$ sudo nginx -t && sudo systemctl reload nginx

ec2$ sudo certbot certonly --webroot -w /var/www/certbot -d api.iot.test.kokoon.pixxo.io \
       --deploy-hook "systemctl reload nginx"
ec2$ sudo certbot certonly --webroot -w /var/www/certbot -d mqtt.test.kokoon.pixxo.io \
       --deploy-hook /home/ec2-user/kokoon-iot-backend/deploy/certbot-mqtt-deploy-hook.sh
ec2$ sudo RENEWED_LINEAGE=/etc/letsencrypt/live/mqtt.test.kokoon.pixxo.io \
       /home/ec2-user/kokoon-iot-backend/deploy/certbot-mqtt-deploy-hook.sh   # first copy

ec2$ sudo cp ~/kokoon-iot-backend/deploy/nginx/kokoon-iot.conf /etc/nginx/conf.d/kokoon-iot.conf
ec2$ sudo nginx -t && sudo systemctl reload nginx
ec2$ systemctl list-timers | grep -i certbot     # renewal timer present
```

`certbot certonly` saves the hooks with each certificate, so renewals copy the
broker's cert and reload it by themselves. If renewal on this box runs from cron
rather than the systemd timer, nothing changes: the hooks still run.

## 4. Broker

```bash
ec2$ cd ~/kokoon-iot-backend/deploy
ec2$ docker compose -f docker-compose.broker.yml up -d
ec2$ docker compose -f docker-compose.broker.yml ps         # STATUS shows (healthy) within ~30 s
ec2$ echo "127.0.0.1 mqtt.test.kokoon.pixxo.io" | sudo tee -a /etc/hosts
```

The `/etc/hosts` line makes the API reach the broker on this box directly,
still over TLS with the right name, instead of going out to the public IP and back.

## 5. API

```bash
ec2$ cd ~/kokoon-iot-backend && npm ci && npm run build
ec2$ pm2 start dist/server.js --name kokoon-iot-backend && pm2 save
ec2$ pm2 logs kokoon-iot-backend --lines 50     # look for the broker connection, no env errors
ec2$ curl -s https://api.iot.test.kokoon.pixxo.io/api/v1/health
```

If it exits with "Invalid environment", the message names each setting to fix in `.env`.

Create the first administrator yourself (production mode needs both flags):

```bash
ec2$ npm run create-admin -- --allow-production --email you@… --password "…" --name "…" --role SUPER_ADMIN
```

## 6. Board certificate check (post-backend)

Boards verify the broker's certificate only when the post-backend gives them a
CA. Without one they still encrypt but print "connection is encrypted but not verified".

```bash
ec2$ sudo openssl crl2pkcs7 -nocrl -certfile /etc/letsencrypt/live/mqtt.test.kokoon.pixxo.io/fullchain.pem \
       | openssl pkcs7 -print_certs -noout
```

The last `issuer=` line names the Let's Encrypt root (for example `ISRG Root X1`).
Download **that one root's** PEM from https://letsencrypt.org/certificates/ into
`~/kokoon-iot-backend/deploy/mosquitto/ca/` (`mkdir -p` it; `push-to-ec2.sh` never touches it). The file must hold a single
certificate, because the classroom flashes only the first one. Then check it:

```bash
ec2$ openssl s_client -connect mqtt.test.kokoon.pixxo.io:8883 -servername mqtt.test.kokoon.pixxo.io \
       -CAfile ~/kokoon-iot-backend/deploy/mosquitto/ca/<root>.pem -verify_return_error </dev/null 2>/dev/null \
       | grep "Verify return code"                  # → 0 (ok)
```

## 7. Post-backend (classroom ↔ IoT Studio)

Append `kokoonlabs-post-backend/.env.production.local` (from your Mac) to the
post-backend's `.env` on the server, plus:

```
IOT_STUDIO_MQTT_CA_FILE=/home/ec2-user/kokoon-iot-backend/deploy/mosquitto/ca/<root>.pem
```

```bash
ec2$ pm2 restart kokoon-post-backend && pm2 logs kokoon-post-backend --lines 30
```

To switch the integration off again: `IOT_INTEGRATION_ENABLED=false` and restart.

## 8. Frontend (S3 + CloudFront, in the AWS console)

1. S3: a new private bucket (e.g. `kokoon-iot-studio-test`), Block Public Access on.
2. ACM in **us-east-1**: a certificate for `iot.test.kokoon.pixxo.io` (DNS validation: one more CNAME).
3. CloudFront distribution:
   - Origin: the bucket, with Origin Access Control. Let it update the bucket policy.
   - Alternate domain `iot.test.kokoon.pixxo.io` with the ACM certificate. Redirect HTTP to HTTPS.
   - Default root object `index.html`.
   - Custom error responses: 403 and 404 → `/index.html`, status 200.
4. DNS: the `iot.test` CNAME → the distribution's `*.cloudfront.net` name.
5. Publish (on your Mac, AWS CLI logged in):

```bash
"Kokoon Frontend/scripts/deploy-s3.sh" kokoon-iot-studio-test <distribution-id>
```

## 9. Check before students use it

- [ ] `https://iot.test.kokoon.pixxo.io` loads; admin sign-in works.
- [ ] From the classroom (`test.kokoon.post.pixxo.io`), "open IoT Studio" signs a student in (SSO).
- [ ] **One real ESP32**, flashed from the classroom: the serial log says `connected`, with **no** "not verified" warning. Telemetry shows live; a dashboard command reaches the board. Watch for memory errors (`OSError: -17040`, `MemoryError`) during the TLS handshake. Every test so far ran on plain 1883.
- [ ] Unplug that board: it shows offline within about 45 s (1.5 × its 30 s keepalive).
- [ ] `docker logs kokoon-iot-broker` shows no repeated auth failures.

## 10. Backups

```bash
ec2$ ~/kokoon-iot-backend/deploy/backup-broker.sh            # once by hand
ec2$ crontab -e
17 */6 * * * /home/ec2-user/kokoon-iot-backend/deploy/backup-broker.sh >> /home/ec2-user/backups/kokoon-iot-broker.log 2>&1
```

Add `BACKUP_S3_URI=s3://…/kokoon-iot-broker` at the start of the cron line to
keep copies off the box too. Mongo and Redis are backed up by Atlas and Redis Cloud.

**Restore the broker** (for example on a new box):

```bash
ec2$ cd ~/kokoon-iot-backend/deploy && docker compose -f docker-compose.broker.yml stop
ec2$ mkdir /tmp/restore && tar -C /tmp/restore -xzf ~/backups/kokoon-iot-broker/broker-<ts>.tgz
ec2$ docker cp /tmp/restore/dynamic-security.json kokoon-iot-broker:/mosquitto/data/dynamic-security.json
ec2$ docker cp /tmp/restore/mosquitto.db kokoon-iot-broker:/mosquitto/data/mosquitto.db
ec2$ docker compose -f docker-compose.broker.yml start      # the start script fixes ownership
```

## 11. Update

```bash
deploy/push-to-ec2.sh ec2-user@18.185.86.182
```

```bash
ec2$ cd ~/kokoon-iot-backend && npm ci && npm run build && pm2 restart kokoon-iot-backend
ec2$ cd deploy && docker compose -f docker-compose.broker.yml up -d    # only if broker files changed
```

## Known gaps

- This folder isn't a git repo yet, so updates go through `push-to-ec2.sh`. Moving to git and `git pull` would give history and a way to roll back.
- No presence timeout: a board that drops without its last-will stays "connected" until it reconnects.
- One API process only: live updates are fanned out in memory.
- Boards connect to Frankfurt from India: about 150 ms per round trip, fine for MQTT.
