import { fork } from 'node:child_process';
import { candleSignature, evaluateSignal, formatSignal } from './signals.js';
import { sessionAt, canDeliver, CLOSE_GRACE_MS } from './session.js';

export async function monitor({ subscriptions, store, send, hours, dryRun, inspect, seconds }) {
  let child = null;
  let stopping = false;
  let nextConnect = 0;
  let failures = 0;
  let activeSession;
  let snapshots = {};
  let dirty = false;
  let recovered = new Set();
  let boundaryLive = new Set();
  const pendingSends = new Set();
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const log = (type, details) => store.log(type, details);

  function saveSnapshot() {
    if (!dirty) return;
    store.writeJson('candles.json', { day: activeSession.day, hours: hours.label, capturedAt: new Date().toISOString(), streams: Object.values(snapshots) });
    dirty = false;
  }

  function stopChild() {
    const previous = child;
    child = null;
    if (!previous) return Promise.resolve();
    return new Promise(resolve => {
      const deadline = setTimeout(() => previous.kill('SIGKILL'), 5000);
      previous.once('exit', () => { clearTimeout(deadline); resolve(); });
      previous.kill('SIGTERM');
    });
  }

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(tick); clearInterval(flush); clearTimeout(limit);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    try {
      await stopChild();
      await Promise.allSettled([...pendingSends]);
      saveSnapshot();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally { finish(); }
  }
  function fatal(error) {
    console.error(error.message);
    process.exitCode = 1;
    void shutdown();
  }

  function accept(packet) {
    const { key, symbol, timeframe, rows, latestClosedTime, pricescale } = packet;
    const now = Date.now();
    snapshots[key] = packet;
    dirty = true;
    if (packet.initial) {
      console.log(`${symbol} ${timeframe}m: ${rows.length} session candles; history ${packet.historyCovered ? 'covered' : 'incomplete'}; ready in ${packet.loadMs} ms`);
      log('stream_ready', { key, candles: rows.length, loadMs: packet.loadMs, historyCovered: packet.historyCovered });
    }
    if (!packet.historyCovered) return;
    const stream = store.data.streams[key] ||= { ignoredThrough: activeSession.start / 1000 - 1 };
    if (!recovered.has(key)) {
      // The latest native closed candle sets the recovery boundary even when
      // its POC is not ready. Never search backward for a qualifying signal.
      stream.ignoredThrough = Math.max(stream.ignoredThrough,
        latestClosedTime === null ? activeSession.start / 1000 - 1 : latestClosedTime - 1);
      recovered.add(key);
      if (now < activeSession.end) boundaryLive.add(key);
      store.save();
      log('recovered_history', { key, ignoredThrough: stream.ignoredThrough, latestClosedTime });
    }
    for (const [index, row] of rows.entries()) {
      const id = `${key}|${row.time}`;
      const signature = candleSignature(row);
      const prior = store.data.records[id];
      if (prior) {
        if (row.confirmed && Number.isFinite(row.poc) && prior.lastSignature !== signature) {
          log('closed_candle_revision', { id, previous: prior.lastSignature, revised: signature });
          prior.lastSignature = signature;
          store.save();
        }
        continue;
      }
      if (row.time <= stream.ignoredThrough || !row.confirmed || !Number.isFinite(row.poc)) continue;
      const closeTime = (row.time + Number(timeframe) * 60) * 1000;
      if (!canDeliver(closeTime, now, activeSession, boundaryLive.has(key))) continue;
      const result = evaluateSignal(rows, index, timeframe);
      // Wait for missing/invalid values to recover instead of freezing a
      // decision based on an incomplete chart packet.
      if (['incomplete-values', 'missing-previous-candle', 'incomplete-volume-history'].includes(result.reason)) continue;
      const text = result.side ? formatSignal(symbol, timeframe, result, pricescale) : null;
      const record = {
        evaluatedAt: new Date(now).toISOString(), lastSignature: signature,
        result, text, status: text ? (dryRun ? 'dry-run' : 'attempting') : 'no-signal',
        boundaryDelayMs: now - closeTime,
      };
      store.data.records[id] = record;
      // Durable reservation BEFORE the HTTP request. If the process crashes
      // mid-send, 'attempting' means uncertain and is never retried.
      store.save();
      log('evaluated', { id, ...record });
      if (!text) continue;
      console.log(`${dryRun ? '[dry-run] ' : ''}${text} | receipt delay ${record.boundaryDelayMs} ms`);
      if (dryRun) continue;
      const delivery = send(text).then(outcome => {
        Object.assign(record, outcome, { completedAt: new Date().toISOString() });
        store.save();
        log('telegram_result', { id, ...outcome });
        console.log(`Telegram ${outcome.status}: ${id}${outcome.errorCode ? ` (code ${outcome.errorCode})` : ''}`);
      }).catch(fatal);
      pendingSends.add(delivery);
      void delivery.finally(() => pendingSends.delete(delivery));
    }
  }

  function connect() {
    recovered = new Set();
    boundaryLive = new Set();
    const collector = fork(new URL('./market-worker.js', import.meta.url), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child = collector;
    const watchdog = setTimeout(() => {
      if (child === collector) {
        console.error('Collector startup timed out; reconnecting.');
        collector.kill('SIGKILL');
      }
    }, 150_000);
    collector.on('message', packet => {
      if (child !== collector || stopping) return;
      try {
        if (packet.type === 'snapshot') {
          accept(packet);
          if (recovered.size === subscriptions.length) { clearTimeout(watchdog); failures = 0; }
        } else if (packet.type === 'error') {
          console.error(`${packet.scope}: ${packet.reason}`);
          log('source_error', packet);
          if (packet.fatal) fatal(new Error('Collector stopped. Correct the configuration or refresh npm run login, then restart.'));
        }
      } catch (error) { fatal(error); }
    });
    collector.on('error', () => fatal(new Error('Could not start the TradingView collector process.')));
    collector.once('exit', () => {
      clearTimeout(watchdog);
      if (child !== collector) return;
      child = null;
      if (stopping) return;
      const delay = Math.min(60_000, 5000 * 2 ** Math.min(failures++, 4));
      nextConnect = Date.now() + delay;
      log('disconnected', { reconnectDelayMs: delay });
      console.log(`Disconnected; next in-session connection in ${delay / 1000}s. History will be recovered without replaying alerts.`);
    });
    collector.send({ subscriptions, session: activeSession });
  }

  let lastWaitingDay;
  let reconciling = false;
  async function reconcile() {
    if (stopping || reconciling) return;
    reconciling = true;
    try {
      const now = Date.now();
      const session = sessionAt(now, hours);
      if (session.day !== activeSession?.day) {
        // A 24:00 cutoff belongs to the previous session. Keep its live stream
        // for the normal close grace before rotating state to the new day.
        if (child && activeSession && now <= activeSession.end + CLOSE_GRACE_MS) return;
        await stopChild();
        await Promise.allSettled([...pendingSends]);
        if (stopping) return;
        activeSession = session;
        store.useDay(session.day);
        snapshots = {}; dirty = false;
      }
      const active = now >= session.start && now < session.end;
      const draining = child && now >= session.end && now <= session.end + CLOSE_GRACE_MS;
      if (!active && !inspect && !draining) {
        if (child) { saveSnapshot(); await stopChild(); }
        if (lastWaitingDay !== session.day) {
          console.log(`Outside ${hours.label}. Waiting for the next session; no catch-up alerts.`);
          lastWaitingDay = session.day;
        }
        return;
      }
      if (!child && (active || inspect) && now >= nextConnect) connect();
    } catch (error) { fatal(error); }
    finally { reconciling = false; }
  }
  const interrupt = () => { void shutdown(); };
  const tick = setInterval(reconcile, 1000);
  const flush = setInterval(() => { try { saveSnapshot(); } catch (error) { fatal(error); } }, 5000);
  const limit = seconds ? setTimeout(interrupt, seconds * 1000) : undefined;
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  reconcile();
  await done;
}
