import { formatIst } from './candles.js';

const aliases = { 'FX:XAUUSD': 'GOLD' };

export function candleSignature(row) {
  return JSON.stringify([row.open, row.high, row.low, row.close, row.volume, row.poc]);
}

export function calculateWick(row, side) {
  return (side === 'Buy' ? row.high - row.open : row.close - row.low) / (row.high - row.low);
}

export function formatWick(wick) {
  return `${Math.round(wick * 100)}%`;
}

/** Rows are native candles in ascending order, restricted to this session. */
export function evaluateSignal(rows, index, timeframe) {
  const current = rows[index];
  if (!['open', 'high', 'low', 'close', 'volume', 'poc'].every(key => Number.isFinite(current[key]))) {
    return { reason: 'incomplete-values' };
  }
  if (index === 0) return { reason: 'first-session-candle' };
  const previous = rows[index - 1];
  const duration = Number(timeframe) * 60;
  if (current.time - previous.time !== duration || !Number.isFinite(previous.volume)) {
    return { reason: 'missing-previous-candle' };
  }
  if (current.volume <= previous.volume) return { reason: 'volume-not-greater' };
  const side = current.close > current.open && current.poc < current.open ? 'Buy'
    : current.close < current.open && current.poc > current.open ? 'Sell' : null;
  if (!side) return { reason: 'price-or-poc-condition' };
  let x = 0;
  for (let i = index - 1; i >= 0; i--) {
    // An unexplained hole prevents us from claiming an exact consecutive count.
    if (rows[i + 1].time - rows[i].time !== duration || !Number.isFinite(rows[i].volume)) {
      return { reason: 'incomplete-volume-history' };
    }
    if (rows[i].volume >= current.volume) break;
    x++;
  }
  const wick = calculateWick(current, side);
  return { side, x, wick, price: side === 'Buy' ? current.low : current.high };
}

export function formatSignal(symbol, timeframe, signal, pricescale, candleTime) {
  const underlying = aliases[symbol] || symbol.split(':').at(-1);
  const minutes = Number(timeframe);
  const interval = minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  // Use the feed's price scale to remove binary float noise without rounding
  // FX prices to an arbitrary number of decimals. Strip display-only zeros.
  const decimals = Number.isFinite(pricescale) && pricescale > 0
    ? Math.min(12, Math.max(0, Math.ceil(Math.log10(pricescale)))) : 10;
  const price = String(Number(signal.price.toFixed(decimals)));
  const wick = formatWick(signal.wick);
  const time = `${formatIst(candleTime).slice(0, 16).replace('T', ' ')} IST`;
  return `${underlying} : ${signal.side} : ${interval} : ${signal.x} : ${wick} : ${price} : ${time}`;
}
