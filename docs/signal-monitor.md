# Signal monitor rules

## Session and candle confirmation

- Every calendar day in Asia/Kolkata (IST). `.env` settings `DAY_OPEN_TIME`
  and `DAY_END_TIME` default to `03:30` and `14:00`. Use 24-hour `HH:mm`;
  `24:00` is allowed only as the end. Full day: `00:00`–`24:00`, not `23:59`.
  End must be later than open; overnight windows are rejected. Restart to apply.
- A candle's native opening timestamp and nominal end must both fit inside
  that window. With the default hours, the 13:30–14:30 hourly candle is excluded; the 13:45–14:00
  fifteen-minute candle is included. Candles are never rebucketed.
- A later native candle and a LuxAlgo study timestamp at or beyond the candle's
  end confirm closure. OHLCV and POC must be finite. The actual Pine study
  provides POC; no local estimate is substituted.
- A candle closing exactly at the configured end can finish arriving for up
  to 60 seconds afterward, only on a stream that finished recovery before the
  cutoff. Starting or reconnecting after the cutoff never produces catch-up alerts.
  With a `24:00` end, the previous session keeps this grace at midnight before
  reconnecting for the new day and recovering its history. Outstanding Telegram
  requests settle before the previous day's state is rotated.
- Each new session resets volume history. The first candle cannot signal.

## Conditions and messages

| Side | Conditions | High/Low field |
| --- | --- | --- |
| Buy | close > open AND POC < open AND volume > previous volume | candle low |
| Sell | close < open AND POC > open AND volume > previous volume | candle high |

All comparisons are strict. Dojis, equal POC/open, and equal volumes fail.
The previous candle is from the same symbol, timeframe and session.

The volume field is **x**, the count of consecutive preceding candles whose
volume is strictly lower than the signal candle's volume. Walk backward from
the immediately previous candle and stop at the first volume >= current.
Preceding candle colour and POC do not affect x. In chronological order,
volumes 130, 80, 90, **120** give x=2; 90, 80, 130, **120** cannot signal.
Unexplained timestamp gaps or invalid volumes withhold an alert when the
previous candle or exact x cannot be established.

```text
Underlying : Buy/Sell : Time frame : x : Low/High : Candle Time
GOLD : Buy : 15m : 2 : 432.5 : 2026-10-02 09:30 IST
GOLD : Sell : 1h : 3 : 438.7 : 2026-10-02 10:30 IST
```

`FX:XAUUSD` maps to GOLD. All other symbols use the suffix after `:`:
USOIL, BTCUSD, EURUSD, GBPUSD, USDJPY for the current Sheet. Timeframes are
displayed as 15m, 30m, 1h, etc. Prices follow the feed's price scale with
unnecessary trailing zeros removed. Messages are plain text in one destination.

Candle Time is the candle's native opening timestamp, displayed as
`YYYY-MM-DD HH:mm IST`. It is not the close time or the message delivery time.

## Recovery, revisions and delivery

The collector requests more than one calendar day's native history on each
connection and waits for the LuxAlgo study's initial completion. Only this
session's candles are retained by the monitor. An incomplete history does not
produce alerts. On startup or reconnect during monitoring hours, evaluate
**every unprocessed closed candle since the configured opening time**. Each
qualifying candle produces its own message with its original candle time.
Candles are evaluated oldest first within each stream; streams load independently,
so delivery order across symbols/timeframes is not globally chronological.
Missing POC values wait for complete data. Future closes continue normally.
Legacy latest-only watermarks are reset automatically, while existing per-candle
evaluation and delivery records are preserved to prevent duplicate attempts.

Evaluation is once per symbol + timeframe + opening timestamp. Later revisions
are logged locally, never reevaluated for a correction message. Volume
comparisons for subsequent candles use the latest recovered source values.

Signals are durably saved as `queued` and sent individually, with at least
3.1 seconds between requests and only one request in flight. This spaces out
backlogs for the [Telegram chat/group limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).
The first message can send immediately when the queue is idle. Messages still
queued when the app stops can resume on the next in-session startup; they have
not made a delivery attempt yet. New signals join the same queue.

Immediately before sending, the monitor durably records `attempting`. It makes exactly one
[Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage) request,
with a 10-second timeout and no retries or redirects. Success records `sent`
and the message ID; a known rejection records `failed` and the HTTP/API code;
an ambiguous response, network failure or timeout records `uncertain`.
Raw API responses and token-bearing URLs are never logged. Telegram rate-limit
rejections are recorded without retrying, just like other delivery failures.
Attempted messages (including failed, uncertain or interrupted attempts) are
not replayed during catch-up. The trading-window check also runs before each
queued request: backlog messages cannot start after the cutoff. Only normal
closing-boundary messages have the existing 60-second grace. Unsent queues
from an earlier day are discarded when the daily state rotates.

A crash can leave `attempting`, treated as uncertain and never resent. This
prevents duplicate attempts but can lose a message if the process crashes
after saving the reservation and before making the HTTP request. Keep state
across restarts. These alerts are for human reading; there is no trade execution.

## Commands and state

`npm start` runs indefinitely. `npm run preview` uses identical conditions but
prints messages without contacting Telegram. Either accepts `--seconds N`
(5–86400) for a bounded run. Preview also accepts `--inspect` to fetch current
session history outside monitoring hours; it still does not evaluate past
signals outside the window. The original snapshot/watch commands remain
independent diagnostics and never send messages.

State is private and ignored by Git:

- `.state/live/state.json`: today's evaluated candles and delivery outcomes.
- `.state/live/events.jsonl`: decisions, revisions, reconnects and delivery results.
- `.state/live/candles.json`: latest view of today's session candles, saved every
  five seconds and at shutdown. This includes forming rows marked unconfirmed.
- `.state/preview/`: separate dry-run state that cannot suppress live alerts.

Files rotate at the next IST calendar day. Only one process can use each state
directory. Normal shutdown removes `monitor.lock`; after a hard crash, inspect
the PID in that file and remove the lock only if that process is no longer
running. An unreadable state file stops startup rather than resetting deduplication.

Transport failures reconnect with 5–60 second backoff. No traffic for 90 seconds,
a study lagging native closes for 90 seconds, or incomplete startup history
after two minutes causes reconnection. Authentication and explicit chart/study
errors stop with a message for operator attention when authentication is valid.
Missing or rejected authentication now pauses collection and unstarted signal
delivery while the parent stays running. A server-side quote token must identify
an authenticated account; JWT syntax alone does not validate login. HTTP 401 or
an explicitly anonymous token requires login; generic 403, 429, 5xx, network and
unexpected-response errors cause a recheck after 30 seconds. A healthy stream
can continue through a temporary authentication-probe failure. Authentication
is also checked at startup, after collector errors, and every ten minutes by
default (`SESSION_CHECK_INTERVAL_SECONDS`, range 30–3600 seconds).

The current window's catch-up policy applies after login recovery as well.
Refresh cookies with `npm run login`, or use the private VPS page described in
[SETUP.md](../SETUP.md). New saved session files are noticed within five seconds
plus request time and reconnect the collector automatically. The monitor attempts
one Telegram login-required notice per incident and one login-restored notice
after authentication succeeds. Restoration does not guarantee chart/study loading
has already completed. These notices share the paced delivery queue but can
send outside trading hours. Their attempt reservations and outcomes live in
`session-health.json`, independently of daily candle-state rotation; attempted
or uncertain notices are never retried. Preview prints notices without sending.

The supplied systemd monitor service puts its process lock in a private runtime
directory recreated across restarts/reboots, while retaining all candle and
notification records in `.state/live`. Foreground live commands also use the
service's runtime directory when present; elsewhere they retain the usual
state-directory lock unless `MONITOR_LOCK_DIRECTORY` is configured.

Google Sheet and `.env` settings are read once;
restart after editing them. A collector child process owns the single shared
WebSocket so a stuck dependency connection can be stopped completely before
replacement. Telegram requests stay in the parent process.

## Live evidence, 1 October 2026

Using the actual Sheet, saved login, six FXCM symbols, and 15m/30m/1h intervals:

- All 18 streams recovered in 3.8 seconds or less.
- 438 in-session candles: 42 + 21 + 10 per symbol.
- All rows had finite direct study POC and confirmed native/study closes.
- Running after 14:00 yielded zero persisted evaluations and zero messages.
- Reviewing those fetched rows through the signal calculation produced, for
  example, `GOLD : Sell : 15m : 1 : 4167.69` for the historical 13:30 IST candle.
  This was inspected locally, not sent to Telegram.

The Telegram credentials were absent during this capture. Outbound delivery,
live close latency, and long-running recovery still need observation during
an actual in-session run. No automated tests were written or run.

## Catch-up preview, 2 October 2026

A live preview using the actual Sheet and configured 00:00–24:00 IST window
evaluated 581 closed candles across 18 streams and printed 48 individual
historical signal messages with candle times. Restarting the preview with the
same state printed no duplicate signals and retained the same evaluation count.
No Telegram requests were made; outbound queue pacing remains unverified with
Telegram. No automated tests were added or run.
