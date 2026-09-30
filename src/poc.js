// Calculation adapted from Volume Delta Candles [LuxAlgo], version 1.0.
// Original copyright LuxAlgo. This file is CC BY-NC-SA 4.0.
// https://www.tradingview.com/script/BdlG9FNZ-Volume-Delta-Candles-LuxAlgo/
// https://creativecommons.org/licenses/by-nc-sa/4.0/

/** Default LTF / Auto 1500 / Premium=false resolves to 1m for 5/15/30/60m.
 * This is the selected intrabar's CLOSE, not a volume-at-price histogram.
 * Bearish direction wins a cross-direction tie. A same-direction tie is
 * explicitly marked ambiguous because Pine sort tie ordering is not promised.
 */
export function luxAlgoPoc(minutes) {
  if (!minutes.length || minutes.some(b => ![b.open, b.close, b.volume].every(Number.isFinite) || b.volume < 0)) {
    return { poc: null, pocStatus: 'missing-volume-or-intrabars' };
  }
  const bullish = minutes.map(b => b.close > b.open ? b.volume : 0);
  const bearish = minutes.map(b => b.close < b.open ? b.volume : 0);
  const bullMax = Math.max(...bullish);
  const bearMax = Math.max(...bearish);
  const selected = bullMax > bearMax ? bullish : bearish;
  const maxVolume = Math.max(...selected);
  const candidates = minutes.filter((_, i) => selected[i] === maxVolume);
  const prices = new Set(candidates.map(b => b.close));
  if (prices.size > 1) return { poc: null, pocStatus: 'ambiguous-volume-tie' };
  return { poc: candidates[0].close, pocStatus: 'ok', pocIntrabarTime: candidates[0].time };
}
