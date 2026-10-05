import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { createConfigReader, createSignalWriter } from './sheets.js';
import { readConfigPollMs, subscriptionsFor } from './config.js';
import { createTelegram } from './telegram.js';
import { MonitorStore } from './monitor-store.js';
import { monitor } from './signal-monitor.js';
import { readSessionHours } from './session.js';
import { readHealthSettings } from './session-health.js';

let store;
try {
  const { values } = parseArgs({ options: {
    'dry-run': { type: 'boolean', default: false },
    inspect: { type: 'boolean', default: false },
    seconds: { type: 'string' },
  } });
  if (values.inspect && !values['dry-run']) throw new Error('--inspect requires --dry-run; outside-session inspection cannot send alerts.');
  const seconds = values.seconds === undefined ? null : Number(values.seconds);
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 5 || seconds > 86400)) {
    throw new Error('--seconds must be 5..86400, or omit it to keep monitoring.');
  }
  const hours = readSessionHours();
  const healthSettings = readHealthSettings();
  const configPollMs = readConfigPollMs();
  const send = values['dry-run'] ? null : createTelegram();
  const sheet = values['dry-run'] ? null : await createSignalWriter();
  const configReader = await createConfigReader();
  const config = await configReader.read();
  for (const warning of config.warnings) console.log(warning);
  const subscriptions = subscriptionsFor(config.instruments);
  // Foreground commands on the VPS must share the service's live lock too.
  const runtimeLock = '/run/tradingview-monitor';
  const lockDirectory = values['dry-run'] ? undefined : process.env.MONITOR_LOCK_DIRECTORY ||
    (fs.existsSync(runtimeLock) ? runtimeLock : undefined);
  store = new MonitorStore(path.resolve(values['dry-run'] ? '.state/preview' : '.state/live'), lockDirectory);
  console.log(`${values['dry-run'] ? 'Preview (no Telegram messages or Sheet writes)' : 'Telegram + Sheet monitor'}: ${subscriptions.length} streams | ${hours.label} | state ${store.directory}`);
  await monitor({ subscriptions, configReader, configPollMs, configWarnings: config.warnings,
    store, send, sheet, hours, healthSettings, dryRun: values['dry-run'], inspect: values.inspect, seconds });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.close(); }
