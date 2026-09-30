# TradingView data feasibility — 30 September 2026 (IST)

## Result

**Browser login, saved-session reuse, native OHLCV and direct LuxAlgo POC
retrieval all work.** Authenticated captures returned POC for all 100 native
candles requested on each of 5m, 15m, 30m and 1h. `FX:XAUUSD` resolves to FXCM.

All **15 populated values in the supplied 5m screenshot match the actual Pine
study output**, using the screenshot's IST timestamps and default indicator
inputs. The earlier local calculation also agrees with the direct Pine result
on all 365 comparable closed candles in the authenticated capture.

| Interval | Native rows with direct POC | Comparable closed local rows | Disagreements |
| --- | ---: | ---: | ---: |
| 5m | 100 | 98 | 0 |
| 15m | 100 | 97 | 0 |
| 30m | 100 | 94 | 0 |
| 1h | 100 | 76 | 0 |

The latest 90-second capture has 99 closed candles and one developing candle
per requested interval. The smaller local-comparison counts reflect missing
minute history, native/minute discrepancies and an ambiguous local volume
tie. Those conditions do not prevent retrieving POC directly from Pine.

## Login and session reuse

`npm run login` opens headed Chrome through Puppeteer. The user completes
sign-in and CAPTCHA normally. The program reads the `sessionid` and
`sessionid_sign` cookies from that browser context, verifies them by requesting
`POST https://www.tradingview.com/quote_token/`, and saves them locally.

The live quote-token response was a **JSON-encoded string**, unlike the raw
JWT assumed in the supplied Python example. Both formats are handled. Tokens
are kept in memory; `.auth/session.json` contains the session cookies. The
file is mode 0600, and `.auth/` and the browser profile are mode 0700.

After the first manual sign-in, a second `npm run login` reused the browser
profile, validated the session and exited successfully without another sign-in.
Separate scraper processes then reused the saved cookies without Chrome.
The chart library obtains its WebSocket auth token from authenticated page
content; the quote-token request also checks the session at startup.

The password-only HTTP route had previously returned `recaptcha_required`.
It has been replaced by the interactive browser flow. No cookie/token values
are printed, and the user's `.env` is not rewritten.

## Captures and timing

Local, ignored evidence:

- `output/authenticated-study/`: first successful authenticated Pine capture,
  including the screenshot comparison and 365 matching closed local rows.
- `output/browser-session-live/`: final default path, direct POC in JSON and
  CSV, plus separate timestamped chart and study events.
- `output/live-validation/`: earlier anonymous capture with **locally
  calculated POC**, used for the candle-boundary measurements below.

The final direct-study capture ran from **01:35:16.891 to 01:36:47.249 IST**.
It used one WebSocket with five chart sessions: one-minute comparison data
plus the four requested native intervals. It recorded no errors or disconnects.

| Item | Time after capture start |
| --- | ---: |
| WebSocket connected | 713 ms |
| Native candles for every interval and 5,000 one-minute bars | 2,357 ms |
| 5m study history | 2,403 ms |
| 15m study history | 2,460 ms |
| 30m study history | 2,486 ms |
| 1h study history / all intervals ready | 2,516 ms |

These times start **after session validation**, not from launching Chrome.
TradingView returned 200 study rows per interval; the output joins POC to the
100 requested native rows by opening timestamp.

Native OHLCV updates had median gaps of about **5.2 seconds**, with observed
maximum gaps around **6.6–6.8 seconds**. Study messages arrived in bursts:
median gaps were 0.38–0.51 seconds, but their 95th-percentile gaps were roughly
5.9–6.3 seconds. These are study-message timings, not a promise that the POC
price changes that often or that every market tick is delivered.

This authenticated capture did not cross a requested 5m/15m/30m/1h boundary,
so **direct Pine candle-close latency is not yet measured**. The one-minute
comparison stream advanced 627 ms after its boundary.

The earlier 534-second anonymous capture measured these closes using the
local POC calculation:

| Interval | Candle open (IST) | Candle close (IST) | Verified receipt delay | POC |
| --- | --- | --- | ---: | ---: |
| 5m | Sep 30 00:50 | Sep 30 00:55 | 635 ms | 4170.07 |
| 5m | Sep 30 00:55 | Sep 30 01:00 | 391 ms | 4169.89 |
| 15m | Sep 30 00:45 | Sep 30 01:00 | 361 ms | 4169.89 |
| 30m | Sep 30 00:30 | Sep 30 01:00 | 375 ms | 4170.87 |

Those observations do not establish the latency of the newly authenticated
study path. A longer run across each requested boundary is needed to measure
that separately. No source exchange tick timestamp is supplied with these
OHLCV messages, so exchange-to-client latency cannot be inferred from them.

## Indicator and candle semantics

The public indicator is [Volume Delta Candles by LuxAlgo](https://www.tradingview.com/script/BdlG9FNZ-Volume-Delta-Candles-LuxAlgo/),
script ID `PUB;b1702429dc1f4ab0a2cbdf51fd796448`, published version `1.0`.
Defaults are `LTF`, resolution `1`, Auto enabled, multiplier `1500`, Premium
disabled. These parent intervals therefore use one-minute intrabars.

POC is exposed by the third `plotcandle`, which repeats the same price in its
open/high/low/close plots. We read `plotcandle_2_ohlc_close` (plot 18). The
Python example reads plot 15, the same candle's open; these represent the same
level. Both `IL` and `ilTemplate` are present in the live translation response;
the installed JavaScript client successfully uses `ilTemplate`.

This max-volume price selects a directional lower-timeframe candle's close;
it is not GoCharting's volume-at-price footprint POC. Doji volume does not
compete, and a bullish/bearish maximum-volume tie selects the bearish side.
The local adaptation cannot resolve every same-side tie; direct Pine output
removes the need to guess Pine's sort order.

Rows are joined by server-supplied candle opening timestamps. One-hour FXCM
candles start at UTC whole hours, which are `:30` in IST. The original supplied
chart query contained `ZXA:XAUUSD`; all captures explicitly request `FX:XAUUSD`.

Default output uses direct Pine POC. Developing bars are provisional. A closed
row becomes signal-eligible only when native candles and the study have both
advanced past it and OHLCV/POC are finite. Missing study data remains null.
Later revisions are logged; signal rules and Telegram delivery are not built.

## Practical limits and remaining work

- **Free-account access:** four simultaneous LuxAlgo studies, one on each
  chart session in a single socket, worked with the supplied account. Anonymous
  study requests previously returned `study_limit_exceeded`. This experiment
  does not establish a multi-symbol capacity limit.
- **History:** the server accepted 5,000 one-minute bars and 100 native bars
  per parent interval. The study supplied POC for older rows beyond the locally
  available minute coverage. Larger history requests have not been explored.
- **Connections:** the published Basic plan lists two simultaneous chart
  connections, and open browser/app charts can consume them. The login browser
  closes before scraping. [Connection rules](https://www.tradingview.com/support/solutions/43000694474-parallel-chart-connections/)
- **Feed:** FXCM is listed as free real-time data. Other exchanges can require
  different entitlements. [Data coverage](https://www.tradingview.com/data-coverage/)
- **Session lifetime:** successful immediate reuse is verified; long-running
  expiry/challenge frequency is not measured. Re-run browser login when needed.
- **Recovery:** this bounded PoC stops on connection/study errors. Reconnect,
  missed-bar backfill and persistent revision handling belong in the next phase.
- **Timing:** measure direct Pine closes across 15m, 30m and 1h boundaries before
  selecting an alert-delay target. Long-term reliability is not established by
  these short captures.

No automated tests or regression fixtures are maintained in this repository.
The local calculation's attribution remains in [NOTICE.md](../NOTICE.md).
