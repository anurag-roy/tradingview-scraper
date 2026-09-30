import { luxAlgoPoc } from './poc.js';

import { parseTimeframe } from './config.js';

export function normalizeBar(bar) {
  return { time: bar.time, open: bar.open, high: bar.max, low: bar.min, close: bar.close, volume: bar.volume };
}

export function formatIst(time) {
  return new Date(time * 1000 + 19_800_000).toISOString().replace('Z', '+05:30');
}

export function aggregate(minutes) {
  if (!minutes.length) return null;
  return {
    open: minutes[0].open,
    high: Math.max(...minutes.map(b => b.high)),
    low: Math.min(...minutes.map(b => b.low)),
    close: minutes.at(-1).close,
    volume: minutes.every(b => Number.isFinite(b.volume))
      ? minutes.reduce((sum, b) => sum + b.volume, 0) : null,
  };
}

export function ohlcvMatches(bar, minutes) {
  const combined = aggregate(minutes);
  return combined !== null && ['open', 'high', 'low', 'close', 'volume'].every(key =>
    Number.isFinite(bar[key]) && Number.isFinite(combined[key]) && Math.abs(bar[key] - combined[key]) < 0.000001);
}

/** Join by server-supplied candle opening timestamps, never by array index.
 * A clock boundary alone never confirms a close: both feeds must advance.
 * Fail closed on incomplete/gapped intrabars or a native-vs-1m mismatch.
 */
export function joinCandles(nativeBars, minuteBars, timeframe, symbol = 'FX:XAUUSD') {
  if (parseTimeframe(timeframe) !== timeframe) throw new Error('Expected a normalized minute timeframe');
  const native = [...nativeBars].sort((a, b) => a.time - b.time);
  const minutes = [...minuteBars].sort((a, b) => a.time - b.time);
  const watermark = minutes.at(-1)?.time ?? -Infinity;
  const latestNative = native.at(-1)?.time ?? -Infinity;
  const byTime = new Map(minutes.map(b => [b.time, b]));
  const duration = Number(timeframe) * 60;
  return native.map(bar => {
    const closeTime = bar.time + duration;
    const closed = bar.time < latestNative && watermark >= closeTime;
    const intrabars = [];
    for (let t = bar.time; t < closeTime; t += 60) {
      if (byTime.has(t)) intrabars.push(byTime.get(t));
    }
    const complete = intrabars.length === Number(timeframe);
    const matches = closed && complete ? ohlcvMatches(bar, intrabars) : null;
    let result = { poc: null, pocStatus: 'incomplete-intrabars' };
    if (complete && closed) {
      result = matches ? luxAlgoPoc(intrabars) : { poc: null, pocStatus: 'ohlcv-mismatch' };
    } else if (!closed && intrabars.length && intrabars[0].time === bar.time) {
      // A running estimate includes the forming 1m bar. It can repaint.
      result = { ...luxAlgoPoc(intrabars), pocStatus: 'provisional' };
    }
    return {
      symbol, timeframe, ...bar,
      timeUtc: new Date(bar.time * 1000).toISOString(), timeIst: formatIst(bar.time),
      closeTimeUtc: new Date(closeTime * 1000).toISOString(),
      state: closed ? 'closed' : 'unconfirmed',
      ...result,
      intrabars: intrabars.length,
      ohlcvMatchesOneMinute: matches,
      signalEligible: closed && complete && matches === true && result.pocStatus === 'ok',
      pocSource: 'local-luxalgo-default-ltf-1m',
    };
  });
}
