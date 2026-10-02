# TradingView scraper

Read instrument/timeframe configuration from Google Sheets and fetch native
open, high, low, close, volume and the actual **LuxAlgo Volume Delta Candles**
POC from TradingView, monitor closed-candle signals and send Telegram alerts.
For snapshot/watch without a sheet, the default is FX:XAUUSD on 15m, 30m and 1h.

## Signal monitor

Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `.env`. Start a conversation
with the bot first, or add it to the destination group/channel with permission
to send messages. Then run:

```sh
npm start                                 # Continuous monitoring from your Sheet
npm run preview                           # Print alerts without sending them
npm run preview -- --inspect --seconds 40  # Inspect today's data outside hours too
```

The monitor requires the Google Sheet and saved TradingView login. It runs
daily from **03:30 to 14:00 IST by default**, waiting between sessions. It evaluates only
fully closed candles inside that window using the agreed green/red, POC and
volume rules. Example message: `GOLD : Buy : 15m : 2 : 432.5 : 2026-10-02 09:30 IST`.
The final field is the candle's opening date and time in IST.

Configure the window in `.env` using 24-hour IST times. For a full calendar day:

```dotenv
DAY_OPEN_TIME=00:00
DAY_END_TIME=24:00
```

`24:00` means midnight at the end of the day; `23:59` would exclude candles
ending at midnight. Omitted/blank values default to `03:30` and `14:00`.
End must be later than open in the same IST day; overnight windows are not
supported. Restart the monitor after changing these settings.

Startup/reconnect during monitoring hours evaluates **all unprocessed closed
candles since today's configured opening time**, then future closes. Each
qualifying candle gets its own Telegram message, including its candle time.
Messages are queued individually with at least 3.1 seconds between requests.
Persistent state prevents repeat attempts across restarts; queued messages
that haven't been attempted resume on recovery. Failed or uncertain attempts
are never retried. Later candle revisions are logged without correction messages.

See [the full signal rules and operating details](docs/signal-monitor.md),
including cutoff behavior, local delivery logs, and crash recovery.
Stop with Ctrl+C. Restart to apply Sheet or `.env` edits.

## Google Sheet configuration

Use the same `config!A1:E8` layout as the original GoCharting scraper:

| A | B | C | D | E |
| --- | --- | --- | --- | --- |
| email | TradingView login (optional) | | | |
| password | TradingView password (optional) | | | |
| Instrument1 | FX:XAUUSD | 5m | 15m | 30m |
| Instrument2 | FX:EURUSD | 1m | 3m | 5m |
| Instrument3 | | | | |
| Instrument4 | | | | |
| Instrument5 | | | | |
| Instrument6 | | | | |

[config.example.csv](config.example.csv) is an importable example with blank
credentials. Column B uses **TradingView `EXCHANGE:SYMBOL` identifiers**.
GoCharting `EXCHANGE:CATEGORY:SYMBOL` identifiers must be replaced with the
matching TradingView symbol, rather than simply removing the category.

Add these to your existing `.env`:

```dotenv
GOOGLE_SHEET_ID=https://docs.google.com/spreadsheets/d/YOUR_ID/edit
GOOGLE_SERVICE_ACCOUNT_JSON=./google-service-account.json
CONFIG_TAB=config
```

Enable the Google Sheets API in the service account's Cloud project, and share
the spreadsheet with that account as **Viewer**. The reader only requests
`spreadsheets.readonly` access. It does not create tabs or write candle data.
As in the original project, `GOOGLE_CLIENT_EMAIL` plus `GOOGLE_PRIVATE_KEY`
can replace the JSON file; escaped `\n` newlines are supported. See
[.env.example](.env.example) for all supported settings.

```sh
npm run config     # Read the sheet and print instruments, with credentials omitted
npm run snapshot   # Fetch every configured symbol/timeframe using the saved session
npm run watch      # Same configuration, streamed for ten minutes
```

The sheet is read **once at the start of each command**. Restart a running
capture to apply edits; automatic config polling is not part of this step.
A blank symbol disables a slot. A symbol without timeframes in C–E is skipped.
Columns F onward are ignored. Minute counts, `5m`, `30min`, `1h` and comma/semicolon
lists are accepted; subscriptions are deduplicated while retaining their slot
and column mappings. Invalid populated cells stop the run with a cell address.
If all slots are blank, no TradingView connection is opened.

Timeframe syntax and TradingView entitlement are separate: a live request for
`10m` was rejected by this free account with `custom_resolution`. The collector
reports that error rather than substituting another interval. `1m`, `3m`, `5m`,
`15m` and `30m` succeeded in the multi-symbol capture.

When a sheet ID is configured, sheet mode is automatic. For an explicit local
run use `--config local`; combining sheet mode with symbol/timeframe overrides
is rejected to avoid silently ignoring the sheet.

## Login and run

Requires Node.js 24+ and a desktop display for the initial browser login.

```sh
npm ci
npm run login
npm run snapshot
```

`login` opens a visible Chrome window using Puppeteer. Choose the Email option
if needed. It fills the login form from the sheet’s email/password rows when
both are populated, otherwise from `TRADINGVIEW_USERNAME` and
`TRADINGVIEW_PASSWORD` in `.env`; you submit the form and complete CAPTCHA or
2FA in the browser. It waits up to 20 minutes, verifies the session using
TradingView's `quote_token` endpoint, saves it, and closes Chrome.

- Session cookies: `.auth/session.json`, readable only by your OS user (0600).
- Persistent Chrome profile: `.auth/browser/`, inside a private 0700 directory.
- Both are ignored by Git. Passwords, cookies and tokens are not printed.
- Your `.env` is not rewritten. The short-lived quote token is not saved.
- Run `npm run login` again when the session expires. It reuses the browser
  profile, so it may finish immediately if you are still signed in.
- Existing `TRADINGVIEW_SESSION` / `TRADINGVIEW_SESSION_SIGN` values in `.env`
  override the saved file. Remove stale overrides before refreshing login.
- Set `PUPPETEER_EXECUTABLE_PATH` to use an existing Chrome installation.
- Editing email/password does not switch an already saved TradingView session.
  To switch accounts, run `npm run login -- --fresh` and complete the new login.
  This clears TradingView cookies only in the scraper’s own Chrome profile.
- `npm run login -- --config local` uses `.env` credentials without reading Sheets.

The scraper runs without opening Chrome once cookies have been saved. It
validates the session at startup; the chart client obtains its WebSocket auth
token using those cookies. An expired session stops the run with instructions
to sign in again.

```sh
# Fifteen-second capture, with actual TradingView indicator output.
npm run snapshot

# Ten-minute stream; keep it running across a candle close to measure delay.
npm run watch

# Include the screenshot's 5m interval.
npm run snapshot -- --config local --timeframes 5,15,30,60

# Longer bounded capture, up to one hour.
npm run watch -- --seconds 1200

# Optional local-calculation comparison mode without signing in.
npm run snapshot -- --config local --auth anonymous --no-study
```

There is no automated test suite in this repository, per the owner's request.
Validation uses actual TradingView sessions, fetched data and recorded timings.
The supplied `fetch_xauusd.py` is reference material; the runnable implementation
is the Node.js code under `src/`.

## Output

Each run saves a timestamped directory under `output/`:

- `candles.csv` and `candles.json`: native OHLCV and POC, joined by candle timestamp.
- `events.jsonl`: received chart/study updates, closed candles and later revisions.
- `summary.json`: startup times, update intervals and observed close delays.
- `minutes.json`: one-minute source candles for the local comparison. With
  multiple symbols this is an array of `{ symbol, rows }` groups.

The collector shares one WebSocket across all configured symbols. JSON groups
and `summary.json` include the originating slot/column mappings; CSV rows
identify their symbol and timeframe. A requested 1m stream also supplies the
comparison data, so it is not subscribed twice.

In the default mode, **`poc` comes directly from the LuxAlgo study**.
`pocSource=tradingview-luxalgo-volume-delta-candles-1.0` identifies it.
JSON also preserves `localPoc`, `localPocStatus`, `localSignalEligible` and
`localPocMatchesStudy` for comparison with the earlier one-minute calculation.
A missing study value remains null; it is never filled with a local estimate.

`time` is the server candle opening time in Unix seconds. `timeUtc` and
`timeIst` represent the same instant. One-hour FXCM bars start at `:30` in IST;
they must not be re-bucketed at IST whole hours. `volume` is the value supplied
by the FXCM feed.

For direct study output, `signalEligible=true` requires a finite POC and OHLCV,
a later native candle, and study data advancing past the candle's end. A forming
POC is marked `provisional`; it can change. Later changes to an emitted closed
candle are recorded as `closed_candle_revision`. Snapshot/watch send no alerts.

With `--no-study`, POC is calculated locally from LuxAlgo's default one-minute
logic. That mode additionally requires complete minute coverage and agreement
with native OHLCV, and withholds ambiguous volume ties. These extra local
checks do not block a value fetched directly from TradingView's Pine engine.

## Current integration evidence

The multi-symbol capture in `output/sheet-config-live-supported/` used the
example config rows and returned direct POC for all 620 requested native rows:
FX:XAUUSD at 5m/15m/30m and FX:EURUSD at 1m/3m/5m. All subscriptions were ready
in 2.02 seconds after authentication, with no errors. No test suite was added.

The user's actual Sheet and service account were verified on 1 October 2026.
All six FXCM symbols at 15m/30m/1h returned OHLCV and direct LuxAlgo POC.
The signal-monitor preview subsequently recovered all 438 candles wholly
inside 03:30–14:00 IST across those 18 streams, with finite POC on every row;
all streams were ready in 3.8 seconds. An outside-hours preview sent no messages
and recorded no signal evaluations. Telegram delivery and live boundary timing
remain unverified until bot credentials are configured and an in-session run
observes a new qualifying close. No automated tests were added or run.

## Completed PoC evidence

Browser login, session reuse, and authenticated retrieval succeeded on
30 September 2026 IST. One socket returned 100 native candles and 100 LuxAlgo
study rows for each of 5m, 15m, 30m and 1h. All 365 closed rows eligible for the
local comparison agreed with the direct indicator output in that capture.

See [recorded findings](docs/poc-findings.md) for capture results and timing
limits. The locally adapted calculation retains LuxAlgo attribution in
[NOTICE.md](NOTICE.md). The default direct mode requests published study
`PUB;b1702429dc1f4ab0a2cbdf51fd796448`, version `1.0`, with its default inputs.
