# Indicator attribution

`src/poc.js` adapts the default lower-timeframe max-volume-price calculation
from **Volume Delta Candles [LuxAlgo]**, public version 1.0, copyright LuxAlgo.
The original Pine source is licensed under **Creative Commons Attribution
NonCommercial ShareAlike 4.0 International (CC BY-NC-SA 4.0)**. The adapted
file uses the same license. This is a JavaScript adaptation limited to the
default one-minute calculation; it adds conservative handling of ambiguous
ties and does not implement the drawing, delta visualization, or tick mode.

- [Original indicator and source](https://www.tradingview.com/script/BdlG9FNZ-Volume-Delta-Candles-LuxAlgo/)
- [License text](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en)

The calculation's license does not grant rights to TradingView/FXCM market
data. This private PoC is not a grant of commercial or redistribution rights.

`@mathieuc/tradingview` is an independent, unofficial client, distributed
under ISC. Its license is in `node_modules/@mathieuc/tradingview/LICENSE`.
