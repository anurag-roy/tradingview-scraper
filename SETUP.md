# Ubuntu VPS setup

This installs the monitor and a password-protected TradingView login portal on a new
**Ubuntu 24.04 LTS x86-64 VPS**. The commands use `/opt/tradingview-scraper`
and your existing `ubuntu` user with sudo access. Start with 2 vCPUs and 4 GB RAM;
watch actual usage after enabling your configured feeds and adjust if needed.

The monitor runs continuously under systemd. Chrome, a virtual display, and
VNC start only when you press **Start login**. You can complete TradingView
login from Android through noVNC, then the display closes automatically.
Nginx provides public HTTPS access and prompts for your portal username/password.
You can use your VPS's public IPv4 address directly; a domain is optional.

```mermaid
flowchart LR
    Phone[Android browser] -->|HTTPS and portal password| Nginx[Nginx on VPS]
    Nginx --> Page[Login page on localhost]
    Page -->|Start login| Chrome[Chrome on VPS virtual display]
    Chrome --> Cookies[Saved session]
    Cookies --> Monitor[Signal monitor]
    Monitor --> Telegram[Telegram notifications]
    Monitor --> Sheets[Google Sheet data column A]
```

## 1. Prepare the server

Buy an x86-64 Ubuntu 24.04 VPS, configure an SSH key, and connect as `ubuntu`.
Run the commands below from that account; use `sudo` where shown for
administrator access. Keep the current SSH session open while setting
up networking. If your SSH port differs from 22, adjust the firewall rule.

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl git xz-utils nano ufw nginx apache2-utils snapd \
  xvfb xauth x11vnc novnc websockify openbox fonts-liberation
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Allow **80 and 443** in your provider's firewall too. Port 80 serves certificate
validation and redirects other requests to HTTPS. Keep **6080, 6081, and 5901
closed** in both firewalls: the app, desktop proxy, and VNC bind only to localhost.

## 2. Install Node.js 24 and Chrome

Use the official Node.js 24 Linux x64 distribution. The following downloads
the current v24 archive, verifies its SHA-256 checksum, and installs it at
`/usr/local/bin/node`, the path used by the supplied service files.

```bash
(
set -e
mkdir -p /tmp/tradingview-node-install
cd /tmp/tradingview-node-install
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
TV_NODE_ARCHIVE=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ {print $2; exit}' SHASUMS256.txt)
test -n "$TV_NODE_ARCHIVE"
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$TV_NODE_ARCHIVE"
sha256sum --check --ignore-missing SHASUMS256.txt
sudo tar -xJf "$TV_NODE_ARCHIVE" -C /usr/local --strip-components=1 --no-same-owner
/usr/local/bin/node --version
/usr/local/bin/npm --version
)
```

Stop if download or checksum verification fails. See the
[official Node.js downloads](https://nodejs.org/en/download) for updated releases.

Install Google's system Chrome package. It brings its Ubuntu dependencies
and sandbox with it; the browser runs as the non-root `ubuntu` user.

```bash
curl -fL -o /tmp/google-chrome-stable_current_amd64.deb \
  https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y /tmp/google-chrome-stable_current_amd64.deb
/usr/bin/google-chrome-stable --version
```

The `.env` below selects this Chrome installation, so Puppeteer's bundled
browser download is unnecessary. Keep Chrome's sandbox enabled. Do not add
`--no-sandbox` or launch Chrome as root. Ubuntu's AppArmor restrictions can
affect separately downloaded browser binaries; using the installed Chrome
package avoids having to disable AppArmor globally.
[Chrome installation](https://support.google.com/chrome/answer/95346),
[Puppeteer sandbox guidance](https://pptr.dev/troubleshooting).

## 3. Deploy this checkout

Deploy a revision that includes this document and the `deploy/` directory.
If your latest changes are still local, push them to your repository or upload
this checkout first. The commands below clone the GitHub revision; they do not
upload uncommitted local changes.

```bash
sudo install -d -m 750 -o ubuntu -g ubuntu /opt/tradingview-scraper
git clone \
  https://github.com/anurag-roy/tradingview-scraper.git /opt/tradingview-scraper
env PUPPETEER_SKIP_DOWNLOAD=true \
  /usr/local/bin/npm ci --prefix /opt/tradingview-scraper
cp /opt/tradingview-scraper/.env.example /opt/tradingview-scraper/.env
chmod 600 /opt/tradingview-scraper/.env
mkdir -m 700 /opt/tradingview-scraper/.auth
```

Reuse your existing `ubuntu` account; no additional Linux user is needed.
If the destination already contains a checkout, reuse it rather than cloning
into a populated directory. All runtime commands, session files, and monitor
state must belong to `ubuntu`.

## 4. Configure public HTTPS and the portal password

Edit `.env` and set `LOGIN_PUBLIC_URL=https://YOUR_PUBLIC_IPV4`, replacing
`YOUR_PUBLIC_IPV4` with the address assigned by your VPS provider. For example,
`https://203.0.113.10` illustrates the format; that example IP is not a real target.
Leave `LOGIN_PROXY_TOKEN` blank on the first setup. If using a domain instead,
point its DNS A record to the VPS and use `https://login.example.com` as the URL.

```bash
cd /opt/tradingview-scraper
nano .env
/usr/local/bin/npm run login:proxy -- --http-only
sudo install -d -m 755 /var/www/tradingview-acme
sudo install -m 600 .auth/tradingview-login.nginx.conf /etc/nginx/sites-available/tradingview-login
sudo ln -s /etc/nginx/sites-available/tradingview-login /etc/nginx/sites-enabled/tradingview-login
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

These commands assume a new VPS without existing Nginx sites. On an existing
server, retain its other sites and reuse the `tradingview-login` link if present.
The HTTP-only configuration serves ACME challenges; it does not expose the app.
The helper generates a random private proxy token in `.env` and a private
configuration in `.auth/`. It reuses the token on later runs and prints neither
the token nor credentials. Run it as `ubuntu`, without sudo.

Install the current stable Certbot snap. IP certificates with webroot require
**Certbot 5.4 or newer**; check the printed version before proceeding.

```bash
sudo snap install --classic certbot
sudo /snap/bin/certbot --version
```

For a public IPv4 address, replace `YOUR_PUBLIC_IPV4` below with the same address
used in `.env`. Certbot prompts for your contact email and terms acceptance.

```bash
sudo /snap/bin/certbot certonly --webroot -w /var/www/tradingview-acme \
  --required-profile shortlived --ip-address YOUR_PUBLIC_IPV4 \
  --cert-name tradingview-login
```

For a domain, run this command **instead** of the IP command, using your hostname:

```bash
sudo /snap/bin/certbot certonly --webroot -w /var/www/tradingview-acme \
  -d login.example.com --cert-name tradingview-login
```

Stop if issuance fails. Both commands use the certificate name expected by the
Nginx template. IP certificates last about six days, so automatic renewal is
required. Keep port 80 reachable for the webroot challenge. A self-signed or
staging certificate does not provide the trusted HTTPS required for phone access.
[IP certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot),
[Certbot installation](https://certbot.eff.org/instructions?ws=nginx&os=snap).

Create your portal password interactively. `owner` is a portal username, not a
new Linux account. Choose a long random password separate from your TradingView
and VNC passwords. `-c` creates the file; omit it when changing an existing
password or adding another portal user.

```bash
sudo htpasswd -cB -C 10 /etc/nginx/tradingview-login.htpasswd owner
sudo chown root:www-data /etc/nginx/tradingview-login.htpasswd
sudo chmod 640 /etc/nginx/tradingview-login.htpasswd
cd /opt/tradingview-scraper
/usr/local/bin/npm run login:proxy
sudo install -m 600 .auth/tradingview-login.nginx.conf /etc/nginx/sites-available/tradingview-login
sudo nginx -t
sudo systemctl reload nginx
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo install -m 755 deploy/tradingview-cert-renew.sh /etc/letsencrypt/renewal-hooks/deploy/tradingview-login
sudo /snap/bin/certbot renew --cert-name tradingview-login --dry-run --run-deploy-hooks
sudo systemctl list-timers --all 'snap.certbot.renew*'
```

The snap schedules renewals; the deploy hook checks Nginx configuration and
reloads it after renewal so the new certificate takes effect. Confirm the
renewal check succeeds and the timer is scheduled. Once the app starts in
step 7, open the HTTPS URL from your phone and verify that it requires the
portal password. Nginx protects all page, API, and desktop requests, including
WebSocket upgrades, and limits request rates. The app verifies the private
proxy token and the authenticated username supplied by Nginx; its origin and
CSRF checks remain enabled. Never run the public service with `--local`.
[Nginx password authentication](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html),
[WebSocket proxying](https://nginx.org/en/docs/http/websocket.html),
[Certbot renewal](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates).

## 5. Configure Google Sheets, Telegram, and the app

In your Google Cloud project, enable the Google Sheets API, create a service
account and download its JSON key. Share your configuration spreadsheet with
that service account as **Editor**, and create a tab named `data`. The app
reads `config!A1:E8` and appends each successfully sent Telegram signal message
to column A of `data`; see
[README.md](README.md#google-sheet-configuration) for the six instrument slots
and timeframe columns. The email/password rows can stay blank; you can type
your TradingView credentials in the remote Chrome window.

Copy the service-account JSON from your computer to the `ubuntu` account
on the VPS, then install it privately. Replace the source path below:

```bash
sudo install -m 600 -o ubuntu -g ubuntu \
  /path/to/uploaded-service-account.json \
  /opt/tradingview-scraper/.auth/google-service-account.json
```

Create a Telegram bot using **@BotFather**, save its token, and start a chat
with the bot or add it to your chosen group. Give it permission to send messages.
Set the bot token in `.env` before using the chat-ID command below.

Edit the configuration:

```bash
nano /opt/tradingview-scraper/.env
```

Populate these values; replace the placeholders with your own:

```dotenv
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
GOOGLE_SHEET_ID=https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit
GOOGLE_SERVICE_ACCOUNT_JSON=./.auth/google-service-account.json
CONFIG_TAB=config
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_CHAT_ID
DAY_OPEN_TIME=03:30
DAY_END_TIME=02:00
SESSION_CHECK_INTERVAL_SECONDS=600
LOGIN_PUBLIC_URL=https://YOUR_PUBLIC_IPV4
LOGIN_TIMEOUT_SECONDS=1200
LOGIN_PORT=6080
LOGIN_DESKTOP_PORT=6081
LOGIN_VNC_PORT=5901
```

Keep the `LOGIN_PROXY_TOKEN` generated in step 4; it is intentionally omitted
from the example above. Keep `LOGIN_PUBLIC_URL` equal to the HTTPS origin you
used for the certificate and Nginx configuration. It must contain no port,
path, query, or fragment. After changing the URL or `LOGIN_PORT`, regenerate
and install the Nginx configuration, reload Nginx, and restart both app services.
If the IP or hostname changes, reissue the certificate for the new address using
the same `tradingview-login` certificate name before installing that configuration.
Leave `TRADINGVIEW_SESSION` and `TRADINGVIEW_SESSION_SIGN` blank: `.env` session
overrides would prevent the monitor from using refreshed browser cookies.
TradingView username/password are optional; manual entry is supported.

`03:30`–`02:00` monitors from 03:30 AM IST through 02:00 AM the next day.
The trading day and Sheet notifications reset at the next 03:30 AM opening,
preserving after-midnight messages with the session that started them.
`00:00`–`24:00` is also supported for a full calendar day. Restart the monitor
after changing the spreadsheet or `.env`.

To find your chat ID, send a message to the bot first, then run this **read-only**
request. It prints chat IDs without printing the token or message contents:

```bash
cd /opt/tradingview-scraper
/usr/local/bin/node --env-file=.env --input-type=module <<'JS'
try {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`, {
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error();
  const chats = new Map();
  for (const update of body.result) {
    const chat = (update.message || update.channel_post || update.my_chat_member)?.chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type });
  }
  console.log([...chats.values()]);
} catch { console.error('Could not read Telegram updates. Check the token and bot setup.'); process.exitCode = 1; }
JS
```

Choose the intended destination and put its numeric ID in `.env`. For a bot
already connected to a webhook/another consumer, `getUpdates` may be unavailable
or empty; use that existing integration to find the ID rather than deleting its
webhook. [Telegram getUpdates documentation](https://core.telegram.org/bots/api#getupdates).

Validate the actual spreadsheet access:

```bash
cd /opt/tradingview-scraper
/usr/local/bin/npm run config
```

## 6. Create the screen-access password

```bash
x11vnc -storepasswd /opt/tradingview-scraper/.auth/vnc.passwd
chmod 600 /opt/tradingview-scraper/.auth/vnc.passwd
```

Choose a VNC password separate from your TradingView and portal passwords.
Classic VNC authentication uses only the first eight characters; public access
is protected by HTTPS and the portal password. Do not put this password in a
URL. You enter it in noVNC when connecting to the display.

## 7. Install and start both systemd services

```bash
sudo cp /opt/tradingview-scraper/deploy/tradingview-monitor.service /etc/systemd/system/
sudo cp /opt/tradingview-scraper/deploy/tradingview-login.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/tradingview-{monitor,login}.service
sudo systemctl daemon-reload
sudo systemctl enable --now tradingview-login.service tradingview-monitor.service
sudo systemctl status tradingview-login.service tradingview-monitor.service
```

Both services run as `ubuntu` and use the `.env` file directly through Node.
No shell environment or interactive SSH session is required. The monitor's
candle/notification state remains under `.state/live`. Its process lock lives in
systemd's private `/run/tradingview-monitor` directory, which is recreated on service restart
and reboot. A crashed process does not leave a permanent boot-blocking lock.
systemd stops the entire process group before restarting either service.

Before the first login, the monitor stays running in `login-required` state
and attempts one Telegram notification with your HTTPS login link. Repeated
checks and service restarts do not repeat that incident's notification.

## 8. Complete login from Android

1. Open `LOGIN_PUBLIC_URL` in Chrome, preferably directly rather than Telegram's
   embedded browser.
2. Enter the portal username (`owner` above) and password in Chrome's sign-in
   prompt. No VPN or additional Android app is needed.
3. Tap **Start login**. You can select **Start a fresh TradingView sign-in** if
   switching accounts or replacing a stale browser login.
4. Connect to the displayed VPS browser and enter the VNC password.
5. Submit TradingView's login form and complete any CAPTCHA or 2FA. Use noVNC's
   sidebar keyboard button to type; landscape orientation or **Open full screen**
   can make the desktop easier to use.
6. The browser closes after the session is verified and saved. The page says
   **Login saved**, and the monitor picks up the file within roughly five
   seconds, plus the authentication request and stream loading time.

The page remains available while Chrome is closed, so you can open a new login
session later without SSH. Browser sessions have a 20-minute login timeout by
default. **Close session** cancels login and stops the temporary display tools;
simply closing your phone's tab does not immediately cancel the session.

## 9. Observe data and delivery

```bash
sudo journalctl -u tradingview-monitor.service -f
```

Look for `Session health: healthy` and actual `stream_ready`/candle output.
You can separately inspect live TradingView data without sending Telegram:

```bash
cd /opt/tradingview-scraper
/usr/local/bin/npm run preview -- --inspect --seconds 40
```

Preview state is separate from live state. Do not start a second live monitor
while the systemd service is running. Confirm actual Telegram receipt: a first
login incident should produce a login-required message followed by a
login-restored message, and qualifying candles should produce signal messages.
The app records one attempt for each notification; it does not retry failed
or uncertain Telegram deliveries. Confirm that each sent signal also appears
verbatim in column A of `data`. Sheet-write outcomes are recorded separately
in the candle's `sheet` field and in `sheet_result` events. Failed or uncertain
Sheet writes are not retried and do not stop later Telegram alerts.
Older-session and undated messages are removed from column A at startup and
each 03:30 AM rollover. Existing current-session messages are preserved.

## Session expiry and recovery

- The monitor checks the authenticated TradingView account every ten minutes,
  and rechecks after collector errors. The interval is configurable.
- It checks for a new saved session every five seconds. A healthy session change
  also reconnects the collector, so switching accounts takes effect promptly.
- Missing cookies, HTTP 401, and explicitly anonymous quote tokens require login.
  Confirmed login loss pauses collection and unstarted signal sends. One login
  notification is reserved persistently before its Telegram request.
- HTTP 403, rate limits, server errors, malformed/short-lived tokens, and network
  failures are treated as unavailable checks and retried after 30 seconds.
  An already authenticated stream can continue through a failed probe. These
  errors alone do not prove the browser login has expired.
- After successful login validation, the app sends one login-restored notification
  and reconnects automatically during the configured monitoring hours. The
  notification confirms authentication; stream loading can still fail separately.
- The current monitor evaluates unprocessed candles from the current trading
  window after reconnecting, including after login recovery. Previously attempted
  messages are not resent. See [signal-monitor.md](docs/signal-monitor.md).
- Cookie expiry metadata is retained but is not used as proof of current access.
  TradingView can revoke sessions earlier. Short-lived quote-token expiry does
  not itself require a manual login.

This uses TradingView's unofficial web/session interface, which can change.
An unexpected authentication response is reported as unavailable rather than
guessing that your login expired. Observe the real VPS's network behavior before
depending on unattended operation.

## Operations and troubleshooting

```bash
sudo journalctl -u tradingview-login.service -n 100 --no-pager
sudo journalctl -u tradingview-monitor.service -n 100 --no-pager
sudo systemctl status nginx
sudo nginx -t
sudo /snap/bin/certbot certificates
sudo ss -ltnp
sudo systemctl restart tradingview-login.service tradingview-monitor.service
```

- **Page returns 401:** enter the portal username/password, separate from
  TradingView. Change the password with
  `sudo htpasswd -B -C 10 /etc/nginx/tradingview-login.htpasswd owner` (without `-c`).
  Fully close Chrome or use an incognito tab if it keeps supplying an old password.
- **Page returns 403:** confirm `LOGIN_PROXY_TOKEN` matches the installed Nginx
  configuration. Regenerate with `npm run login:proxy`, install the private copy
  as in step 4, reload Nginx, and restart the login service. Use the exact
  `LOGIN_PUBLIC_URL` when opening the page. Keep production mode enabled.
- **Page returns 502:** check that `tradingview-login.service` is running and
  Nginx forwards to its configured localhost port.
- **HTTPS certificate warning:** inspect `certbot certificates`, the renewal
  timer, and `sudo journalctl -u snap.certbot.renew.service`. Confirm port 80 is
  reachable and the deploy hook reloads Nginx. Use the same IP/hostname as the
  certificate; IP certificates need renewal approximately every six days.
- **Start login fails:** check `.auth/vnc.passwd`, installed display packages,
  ownership, and `.auth/remote-login.log`. That private file is overwritten for
  each session. Missing display dependencies do not affect the monitor.
- **Black screen / disconnected display:** inspect the private login log and
  service journal. The display also disconnects normally after successful login
  or the timeout. Start a new session rather than trying to reuse a closed one.
- **Chrome sandbox error:** confirm Chrome is installed at the configured path
  and the login service runs as `ubuntu`. Inspect Ubuntu AppArmor logs and
  the [Puppeteer troubleshooting guide](https://pptr.dev/troubleshooting). Keep
  the sandbox and AppArmor enabled; do not work around this with root Chrome.
- **Google 403:** enable the Sheets API and share the sheet with the service
  account as Editor for signal logging. Check the JSON path and permissions.
- **Telegram signal missing from the Sheet:** confirm the `data` tab exists,
  column A is writable, and the service account has Editor access. Inspect
  `sheet_result` events and the candle record's `sheet` outcome.
- **Session valid but collector stops:** check timeframe entitlement, symbol
  identifiers and chart/study errors. These are distinct from expired login.
- **No Telegram message:** check bot permissions and `.state/live/session-health.json`
  or candle delivery outcomes. `failed`/`uncertain`/`attempting` notices are never
  automatically retried, even after a restart.
- **Monitor state unreadable:** stop the service and inspect the file before
  changing it. Do not delete `.state/live` as routine cleanup; it prevents repeat
  delivery attempts. Local foreground runs use `.state/live/monitor.lock` unless
  a lock directory is supplied; inspect its PID before removing a stale lock.
- **Service start limit reached:** fix the logged configuration problem, then run
  `sudo systemctl reset-failed tradingview-monitor tradingview-login` and start
  the services again.

To update, stop both services, deploy the new revision, run `npm ci` as the
`ubuntu` user with `PUPPETEER_SKIP_DOWNLOAD=true`, and restart both services.
Copy changed service files and run `daemon-reload` if their configuration changed.
For proxy template changes, regenerate/install the private Nginx configuration,
run `nginx -t`, and reload Nginx. Preserve the existing proxy token.
Preserve `.env`, `.auth/`, and `.state/`. Update Ubuntu and Chrome security packages
regularly; reboot when required and confirm both services recover.

## Local development

The existing `npm run login` continues to open Chrome on your local desktop.
For the portal UI on this computer only:

```bash
npm run login:server -- --local
```

Open `http://127.0.0.1:6080`. Remote desktop launching still requires the Linux
packages and VNC password above. Production mode requires the private Nginx
proxy token and an authenticated portal user; it rejects direct requests.
No automated test suite is maintained; validation uses actual login, data
retrieval, and observed output.
