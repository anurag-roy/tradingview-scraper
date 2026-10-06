# Signal monitor rules

## Session and candle confirmation

- Every trading day in Asia/Kolkata (IST). `.env` settings `DAY_OPEN_TIME`
  and `DAY_END_TIME` default to `03:30` and `02:00`: 03:30 AM through
  02:00 AM the next morning. Use 24-hour `HH:mm`;
  `24:00` is allowed only as the end. Full day: `00:00`–`24:00`, not `23:59`.
  End earlier than open crosses midnight; equal open/end is rejected.
  The session uses its opening date, and resets at the next opening rather
  than midnight. The 02:00–03:30 break retains the just-ended session. Restart to apply.
- A candle's native opening timestamp and nominal end must both fit inside
  that window. With the default hours, the 01:30–02:30 hourly candle is excluded; the 01:45–02:00
  fifteen-minute candle is included. Candles are never rebucketed.
- A later native candle and a LuxAlgo study timestamp at or beyond the candle's
  end confirm closure. OHLCV and POC must be finite. The actual Pine study
  provides POC; no local estimate is substituted.
- A candle closing exactly at the configured end can finish arriving for up
  to 60 seconds afterward, only on a stream that finished recovery before the
  cutoff. Starting or reconnecting after the cutoff never produces catch-up alerts.
  If the next session starts at the cutoff, the previous session keeps its grace before
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

The **wick** field is `(high - close) / (high - low)` for Buy and
`(close - low) / (high - low)` for Sell, using the signal candle's prices.
Multiply the ratio by 100, round to a whole number, and append `%`.

```text
Underlying : Buy/Sell : Time frame : x : wick% : Low/High : Candle Time
GOLD : Buy : 15m : 2 : 19% : 4124 : 2026-10-06 09:00 IST
USOIL : Sell : 15m : 7 : 31% : 90.028 : 2026-10-06 10:15 IST
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

After Telegram confirms `sent`, the monitor appends the same saved message
text to the next row in `data!A:A` in the configured spreadsheet. One signal
occupies one cell, using `RAW` input to preserve its text. The `data` tab must
exist, and the service account must have **Editor** access. Only signal messages
are written; login-required and login-restored notices remain in Telegram.
The Sheet outcome is stored separately in the candle record's `sheet` field
and logged as `sheet_result`: `written` with the updated range, `failed` for
a known rejection, or `uncertain` for an ambiguous response or network failure.
Each append has a 20-second timeout and no automatic retry. Sheet failures
leave the Telegram result intact and allow the queue to continue. Preview
makes no Sheet writes, and earlier Telegram sends are not automatically backfilled.

At startup and each session opening, column A is compacted to retain only
messages whose candle time falls inside the current trading session. With
the defaults, messages from 00:00–02:00 AM belong to the previous opening
date and stay until 03:30 AM. Older and undated entries are removed. Retained
message strings are unchanged; cleanup updates only column A's cell values,
preserving other columns, the config tab, and cell formatting.
Cleanup shares the delivery queue so it cannot overwrite a concurrent append,
and runs even when TradingView login is unavailable. Failed cleanup is retried
at most once per minute. Until cleanup succeeds, Telegram continues but Sheet
appends are recorded as `skipped` with `session-cleanup-not-confirmed`; those
signals are not backfilled. Cleanup outcomes are logged as `sheet_cleanup`.

A crash can leave `attempting`, treated as uncertain and never resent. This
prevents duplicate attempts but can lose a message if the process crashes
after saving the reservation and before making the HTTP request. A crash
between the Telegram send and the Sheet append can also leave an unlogged
signal; interrupted Sheet writes are not replayed. Keep state
across restarts. These alerts are for human reading; there is no trade execution.

## Commands and state

The live and preview monitors read the Sheet's instruments and timeframes every
five seconds by default (`CONFIG_POLL_MS`, an integer of at least 1000
milliseconds). Only a change to the deduplicated symbol/timeframe subscriptions
refreshes the collector; moving the same stream between slots or writing an
equivalent timeframe does not reconnect. The refresh briefly reloads all active
chart/study histories. Their saved candle records and queued messages are kept.
New streams use the same catch-up policy as startup: every unprocessed qualifying
closed candle from this session's opening, including candles before the edit.
Removing and readding a stream in the same session retains its delivery history.

Removed streams are excluded from incoming packets and checked again immediately
before each Telegram attempt. Queued messages for a removed stream are withheld;
they can resume if that stream is readded during the session. An already-started
request can finish, and previous `data` messages stay until normal session cleanup.
Unchanged streams can finish their closing-boundary grace when an edit arrives
at the session cutoff; added streams wait for the next monitoring session.

Config reads run independently of collection and delivery, with no overlapping
polls. A failed read or invalid populated cell logs an error and keeps the last
valid instrument list. Correcting the Sheet is picked up by a later poll.
Blanking all instruments pauses the collector while polling continues; the
monitor can also start with an empty list. Polling continues outside market hours
and while TradingView login is unavailable. Changing email/password cells does
not replace the saved browser-session authentication.

`npm start` runs indefinitely. `npm run preview` uses identical conditions but
prints messages without contacting Telegram or writing to Sheets. Either accepts `--seconds N`
(5–86400) for a bounded run. Preview also accepts `--inspect` to fetch current
session history outside monitoring hours; it still does not evaluate past
signals outside the window. The original snapshot/watch commands remain
independent diagnostics and never send messages.

For a copyable list of the current session's saved signal messages, run
`npm run --silent messages` on the monitor's machine. The command recalculates
wick using the original evaluation prices where available, preserving all other
message fields, then prints one message per line in candle-time order. It handles
both messages without wick and messages with an older wick value. Every saved
signal is included regardless of Telegram or Sheet delivery outcome. It only
reads the saved state and event log, so it can run alongside the monitor without
contacting TradingView, Sheets, or Telegram. It uses the configured session hours,
including the overnight session, and rejects state from a different session.
Use `--state-dir /path/to/state` to select a different directory. This is a list
of signals already recorded by the monitor, not a fresh history fetch.

State is private and ignored by Git:

- `.state/live/state.json`: today's evaluated candles and Telegram/Sheet outcomes.
- `.state/live/events.jsonl`: decisions, revisions, reconnects and delivery results.
- `.state/live/candles.json`: latest view of today's session candles, saved every
  five seconds and at shutdown. This includes forming rows marked unconfirmed.
- `.state/preview/`: separate dry-run state that cannot suppress live alerts.

Files rotate at the next trading-session opening. Only one process can use each state
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

`.env` settings are read once; restart after editing them. The diagnostic
snapshot/watch/login/config commands also read the Sheet once per command.
Config changes and failures are logged as `config_applied`, `config_read_failed`,
and `config_read_restored` in `events.jsonl`.
A collector child process owns the single shared
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

## Live config-change preview, 5 October 2026

A temporary configuration tab in the actual spreadsheet was edited manually
while preview collected real TradingView data. The live `config` and `data` tabs
were left intact. Preview used a 03:30–03:00 next-day window to observe catch-up
during the normal 02:00–03:30 break; the production window was unchanged.

- Adding a fourth instrument loaded its history and printed its earlier signals.
- Replacing a symbol and changing 15m to 5m refreshed the appropriate subscriptions.
- Moving unchanged streams between slots produced no reconnect.
- An invalid timeframe retained the working list; correction restored reads.
- Clearing all slots stopped the collector while the parent kept polling.
- Starting with an empty list and readding ETHUSD 15m loaded 91 session candles
  without repeating its 90 existing evaluations. Total state stayed at 497
  evaluations and 52 preview signals.

The temporary tab was removed afterward. No Telegram messages or signal-sheet
appends were attempted. Syntax and diff checks passed; no automated tests were
added or run.
