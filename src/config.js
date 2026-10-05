/** TradingView uses minute counts for intraday resolutions (including hours). */
export function parseTimeframe(raw) {
  const text = String(raw ?? '').trim();
  const match = text.match(/^(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:ours?)?)?$/i);
  const minutes = match ? Number(match[1]) * (/^h/i.test(match[2] || '') ? 60 : 1) : NaN;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('Use minute/hour intervals from 1m to 1440m, such as 2m, 10m, 30m or 1h.');
  }
  return String(minutes);
}

export function parseSymbol(raw) {
  const symbol = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9_]+:[A-Za-z0-9_!.\/-]+$/.test(symbol)) {
    throw new Error('Use a TradingView EXCHANGE:SYMBOL identifier, such as FX:XAUUSD; GoCharting EXCHANGE:CATEGORY:SYMBOL codes are not supported.');
  }
  return symbol;
}

export function readConfigPollMs(env = process.env) {
  const interval = Number(env.CONFIG_POLL_MS || 5000);
  if (!Number.isInteger(interval) || interval < 1000) {
    throw new Error('CONFIG_POLL_MS must be an integer of at least 1000.');
  }
  return interval;
}

export function parseConfigRows(rows) {
  const entries = new Map();
  const warnings = [];
  for (const [index, row] of rows.entries()) {
    const key = String(row[0] ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (!key) continue;
    if (!/^(email|password|instrument[1-6])$/.test(key)) {
      warnings.push(`Ignoring unrecognized label in A${index + 1}.`);
      continue;
    }
    if (entries.has(key)) throw new Error(`Duplicate config label in A${index + 1}.`);
    entries.set(key, { row, number: index + 1 });
  }
  const instruments = [];
  for (let slot = 1; slot <= 6; slot++) {
    const entry = entries.get(`instrument${slot}`);
    if (!entry || !String(entry.row[1] ?? '').trim()) continue;
    let symbol;
    try { symbol = parseSymbol(entry.row[1]); } catch (error) {
      throw new Error(`B${entry.number}: ${error.message}`);
    }
    const intervals = [];
    for (let column = 2; column <= 4; column++) {
      for (const token of String(entry.row[column] ?? '').split(/[,;]/).filter(t => t.trim())) {
        let timeframe;
        try { timeframe = parseTimeframe(token); } catch (error) {
          throw new Error(`${String.fromCharCode(65 + column)}${entry.number}: ${error.message}`);
        }
        if (!intervals.some(i => i.timeframe === timeframe)) {
          intervals.push({ timeframe, column: String.fromCharCode(65 + column) });
        }
      }
    }
    if (!intervals.length) {
      warnings.push(`Instrument${slot} has no timeframes in C–E; skipping.`);
      continue;
    }
    instruments.push({ slot, symbol, timeframes: intervals.map(i => i.timeframe), intervals });
  }
  return {
    credentials: {
      username: String(entries.get('email')?.row[1] ?? '').trim(),
      password: String(entries.get('password')?.row[1] ?? ''),
    },
    instruments, warnings,
  };
}

/** Merge subscriptions while preserving the originating config slots/cells. */
export function subscriptionsFor(instruments) {
  const subscriptions = new Map();
  for (const instrument of instruments) {
    for (const timeframe of instrument.timeframes) {
      const key = `${instrument.symbol}|${timeframe}`;
      if (!subscriptions.has(key)) subscriptions.set(key, { key, symbol: instrument.symbol, timeframe, slots: [] });
      subscriptions.get(key).slots.push({ slot: instrument.slot, column: instrument.intervals?.find(i => i.timeframe === timeframe)?.column ?? null });
    }
  }
  return [...subscriptions.values()];
}
