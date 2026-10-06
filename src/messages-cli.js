import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { sessionAt, insideSession } from './session.js';
import { calculateWick, formatWick } from './signals.js';

try {
  const { values } = parseArgs({ options: {
    'state-dir': { type: 'string', default: '.state/live' },
  } });
  const directory = path.resolve(values['state-dir']);
  const session = sessionAt();
  const file = path.join(directory, 'state.json');
  if (!fs.existsSync(file)) {
    throw new Error(`No saved monitor state at ${file}. Run this command on the monitor's machine.`);
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.version !== 1 || !state.records) throw new Error('Unsupported saved monitor state.');
  if (state.day !== session.day) {
    throw new Error(`Saved state is for ${state.day}, but the current trading session is ${session.day}. Run this command where the monitor is collecting this session's data.`);
  }

  // The state signature can change after a candle revision. Prefer the prices
  // logged when its original signal was evaluated, keeping the other fields.
  const originalSignatures = new Map();
  const eventsFile = path.join(directory, 'events.jsonl');
  if (fs.existsSync(eventsFile)) {
    const lines = fs.readFileSync(eventsFile, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch {
        // A concurrent append may leave the last line incomplete in our read.
        if (index === lines.length - 1) continue;
        throw new Error('Saved event log is unreadable.');
      }
      if (event.type === 'evaluated' && !originalSignatures.has(event.id)) {
        originalSignatures.set(event.id, event.lastSignature);
      }
    }
  }

  const messages = [];
  for (const [id, record] of Object.entries(state.records)) {
    if (!['Buy', 'Sell'].includes(record.result?.side) || typeof record.text !== 'string') continue;
    const [, timeframe, timestamp] = id.split('|');
    const time = Number(timestamp);
    if (!Number.isFinite(time) || !insideSession({ time }, timeframe, session)) continue;
    const [open, high, low, close] = JSON.parse(originalSignatures.get(id) || record.lastSignature);
    if (![open, high, low, close].every(Number.isFinite) || high <= low) {
      throw new Error(`Saved candle prices are invalid for ${id}.`);
    }
    const fields = record.text.split(' : ');
    if (![6, 7].includes(fields.length)) throw new Error(`Saved message format is unsupported for ${id}.`);
    // Insert wick into older messages or replace it in messages that have it.
    const wick = formatWick(calculateWick({ open, high, low, close }, record.result.side));
    fields.splice(4, fields.length - 6, wick);
    messages.push({ id, time, text: fields.join(' : ') });
  }
  messages.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  if (messages.length) process.stdout.write(`${messages.map(message => message.text).join('\n')}\n`);
  else console.error(`No saved signal messages for trading session ${session.day}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
