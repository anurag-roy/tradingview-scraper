import { parseArgs } from 'node:util';
import path from 'node:path';
import { authenticate } from './auth.js';
import { capture } from './capture.js';
import { parseSymbol, parseTimeframe, subscriptionsFor } from './config.js';
import { createConfigReader, hasSheetConfig } from './sheets.js';

try {
  const { values } = parseArgs({ allowNegative: true, options: {
    symbol: { type: 'string' },
    timeframes: { type: 'string' },
    history: { type: 'string', default: '5000' },
    seconds: { type: 'string', default: '15' },
    output: { type: 'string' },
    auth: { type: 'string', default: 'session' },
    study: { type: 'boolean', default: true },
    config: { type: 'string', default: hasSheetConfig() ? 'sheet' : 'local' },
  } });
  const seconds = Number(values.seconds);
  const history = Number(values.history);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) throw new Error('--seconds must be 5..3600');
  if (!Number.isInteger(history) || history < 120 || history > 5000) throw new Error('--history must be 120..5000');
  if (!['sheet', 'local'].includes(values.config)) throw new Error('--config must be sheet or local');
  let instruments;
  if (values.config === 'sheet') {
    if (values.symbol || values.timeframes) throw new Error('Sheet mode uses the symbols/timeframes in the sheet. Use --config local for command-line overrides.');
    const config = await (await createConfigReader()).read();
    instruments = config.instruments;
    for (const warning of config.warnings) console.log(warning);
  } else {
    const timeframes = [...new Set((values.timeframes || '15,30,60').split(',').map(parseTimeframe))];
    instruments = [{ slot: null, symbol: parseSymbol(values.symbol || 'FX:XAUUSD'), timeframes }];
  }
  if (!instruments.length) {
    console.log('No active instruments: fill column B and at least one timeframe in C–E. Nothing subscribed.');
  } else {
    const output = path.resolve(values.output || `output/${new Date().toISOString().replaceAll(':', '-')}`);
    const auth = await authenticate(values.auth);
    console.log(`Config=${values.config} | ${instruments.length} instrument slots | auth=${auth.mode} | ${seconds}s capture`);
    for (const { symbol, timeframe, slots } of subscriptionsFor(instruments)) {
      console.log(`${symbol} ${timeframe}m${slots[0]?.slot ? ` | slots ${slots.map(s => s.slot).join(', ')}` : ''}`);
    }
    const result = await capture({ instruments, seconds, history, output, auth, study: values.study });
    console.log(`Saved ${output}`);
    for (const group of result.data) {
      const row = group.rows.filter(row => row.signalEligible).at(-1);
      console.log(`${group.symbol} ${group.timeframe}m latest closed candle: ${row ? JSON.stringify(row) : 'NONE'}`);
    }
    if (result.summary.errors.length || result.summary.firstCompleteMs === null) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
