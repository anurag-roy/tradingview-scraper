import { fork } from 'node:child_process';
import { candleSignature, evaluateSignal, formatSignal } from './signals.js';
import { sessionAt, canDeliver, CLOSE_GRACE_MS } from './session.js';
import { DeliveryQueue } from './delivery-queue.js';
import { SessionHealth } from './session-health.js';
import { subscriptionsFor } from './config.js';

export async function monitor({ subscriptions, configReader, configPollMs, configWarnings,
  store, send, sheet, hours, healthSettings, dryRun, inspect, seconds }) {
  let child = null;
  let stopping = false;
  let nextConnect = 0;
  let failures = 0;
  let activeSession;
  let sheetDay;
  let nextSheetCleanup = 0;
  let snapshots = {};
  let dirty = false;
  let recovered = new Set();
  let boundaryLive = new Set();
  const deliveries = new DeliveryQueue(fatal);
  const health = new SessionHealth({ store, deliveries, send, dryRun, settings: healthSettings });
  let collectorRevision;
  let configRevision = 0;
  let collectorConfigRevision;
  let configuredKeys = new Set(subscriptions.map(spec => spec.key));
  let readingConfig = false;
  let configReadError;
  let warningSignature = JSON.stringify(configWarnings);
  const configController = new AbortController();
  let sourceError;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const log = (type, details) => store.log(type, details);

  async function pollConfig() {
    if (stopping || readingConfig) return;
    readingConfig = true;
    try {
      let config;
      try { config = await configReader.read({ signal: configController.signal }); }
      catch (error) {
        if (stopping) return;
        if (error.message !== configReadError) {
          console.error(`Config refresh failed; keeping the last valid instruments. ${error.message}`);
          log('config_read_failed', { reason: error.message });
        }
        configReadError = error.message;
        return;
      }
      if (stopping) return;
      if (configReadError) {
        console.log('Config reads restored.');
        log('config_read_restored');
        configReadError = null;
      }
      const warnings = JSON.stringify(config.warnings);
      if (warnings !== warningSignature) {
        for (const warning of config.warnings) console.log(warning);
        warningSignature = warnings;
      }
      const next = subscriptionsFor(config.instruments);
      const nextKeys = new Set(next.map(spec => spec.key));
      const added = next.filter(spec => !configuredKeys.has(spec.key)).map(spec => spec.key);
      const removed = subscriptions.filter(spec => !nextKeys.has(spec.key)).map(spec => spec.key);
      subscriptions = next;
      configuredKeys = nextKeys;
      if (!added.length && !removed.length) return;
      configRevision++;
      nextConnect = 0; failures = 0; sourceError = null;
      for (const key of removed) {
        delete snapshots[key];
        recovered.delete(key);
        boundaryLive.delete(key);
      }
      if (removed.length) { dirty = true; saveSnapshot(); }
      log('config_applied', { added, removed, streams: subscriptions.length });
      console.log(`Config applied: ${subscriptions.length} streams | added ${added.join(', ') || 'none'} | removed ${removed.join(', ') || 'none'}`);
      void reconcile();
    } catch (error) { fatal(error); }
    finally { readingConfig = false; }
  }

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
    configController.abort();
    health.close();
    clearInterval(configTick); clearInterval(tick); clearInterval(flush); clearTimeout(limit);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    const closingDeliveries = deliveries.close();
    try {
      await stopChild();
      await closingDeliveries;
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

  function queueSheetCleanup(session, now) {
    if (dryRun || sheetDay === session.day || now < nextSheetCleanup) return;
    nextSheetCleanup = now + 60_000;
    deliveries.enqueue(`sheet-cleanup:${session.day}`, async () => {
      if (stopping || activeSession.day !== session.day) return false;
      const outcome = await sheet.keepSession(session);
      if (outcome.status === 'pruned') sheetDay = session.day;
      nextSheetCleanup = Date.now() + 60_000;
      log('sheet_cleanup', { day: session.day, ...outcome });
      console.log(`Sheet cleanup ${outcome.status}: ${session.day}${outcome.status === 'pruned'
        ? ` | removed ${outcome.removed}, kept ${outcome.kept}` : outcome.hint ? ` | ${outcome.hint}` : ''}`);
      return false;
    });
  }

  function queueDelivery(id, key, record, closeTime) {
    if (dryRun || !configuredKeys.has(key) || !canDeliver(closeTime, Date.now(), activeSession, boundaryLive.has(key))) return;
    const session = activeSession;
    deliveries.enqueue(id, async () => {
      if (stopping || !health.canCollect || !configuredKeys.has(key) || record.status !== 'queued' || store.data.day !== session.day ||
        !canDeliver(closeTime, Date.now(), session, boundaryLive.has(key))) return false;
      // Reserve only when this request is about to start. A queued message
      // survives a restart without being mistaken for an attempted delivery.
      record.status = 'attempting';
      record.attemptedAt = new Date().toISOString();
      store.save();
      const outcome = await send(record.text);
      Object.assign(record, outcome, { completedAt: new Date().toISOString() });
      store.save();
      log('telegram_result', { id, ...outcome });
      console.log(`Telegram ${outcome.status}: ${id}${outcome.errorCode ? ` (code ${outcome.errorCode})` : ''}`);
      if (outcome.status === 'sent') {
        let sheetOutcome;
        if (sheetDay !== session.day) {
          sheetOutcome = { status: 'skipped', reason: 'session-cleanup-not-confirmed' };
          record.sheet = {};
        } else {
          record.sheet = { status: 'attempting', attemptedAt: new Date().toISOString() };
          store.save();
          sheetOutcome = await sheet.append(record.text);
        }
        Object.assign(record.sheet, sheetOutcome, { completedAt: new Date().toISOString() });
        store.save();
        log('sheet_result', { id, ...sheetOutcome });
        console.log(`Sheet ${sheetOutcome.status}: ${id}${sheetOutcome.hint ? ` | ${sheetOutcome.hint}` : ''}`);
      }
      return true;
    });
  }

  function accept(packet) {
    if (!health.canCollect) return;
    const { key, symbol, timeframe, rows, latestClosedTime, pricescale } = packet;
    if (!configuredKeys.has(key)) return;
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
      // Replace legacy latest-only watermarks, preserving per-candle records.
      // All unprocessed candles since today's open can now produce alerts.
      stream.ignoredThrough = activeSession.start / 1000 - 1;
      recovered.add(key);
      if (now < activeSession.end) boundaryLive.add(key);
      store.save();
      log('recovered_history', { key, mode: 'all-unprocessed-session-candles', ignoredThrough: stream.ignoredThrough, latestClosedTime });
    }
    for (const [index, row] of rows.entries()) {
      const id = `${key}|${row.time}`;
      const signature = candleSignature(row);
      const closeTime = (row.time + Number(timeframe) * 60) * 1000;
      const prior = store.data.records[id];
      if (prior) {
        if (row.confirmed && Number.isFinite(row.poc) && prior.lastSignature !== signature) {
          log('closed_candle_revision', { id, previous: prior.lastSignature, revised: signature });
          prior.lastSignature = signature;
          store.save();
        }
        if (prior.status === 'queued') queueDelivery(id, key, prior, closeTime);
        continue;
      }
      if (row.time <= stream.ignoredThrough || !row.confirmed || !Number.isFinite(row.poc)) continue;
      if (!canDeliver(closeTime, now, activeSession, boundaryLive.has(key))) continue;
      const result = evaluateSignal(rows, index, timeframe);
      // Wait for missing/invalid values to recover instead of freezing a
      // decision based on an incomplete chart packet.
      if (['incomplete-values', 'missing-previous-candle', 'incomplete-volume-history'].includes(result.reason)) continue;
      const text = result.side ? formatSignal(symbol, timeframe, result, pricescale, row.time) : null;
      const record = {
        evaluatedAt: new Date(now).toISOString(), lastSignature: signature,
        result, text, status: text ? (dryRun ? 'dry-run' : 'queued') : 'no-signal',
        boundaryDelayMs: now - closeTime,
      };
      store.data.records[id] = record;
      // Save the decision before queuing; each request gets a durable attempt
      // reservation separately, immediately before contacting Telegram.
      store.save();
      log('evaluated', { id, ...record });
      if (!text) continue;
      console.log(`${dryRun ? '[dry-run] ' : ''}${text} | receipt delay ${record.boundaryDelayMs} ms`);
      if (dryRun) continue;
      queueDelivery(id, key, record, closeTime);
    }
  }

  function connect() {
    collectorRevision = health.revision;
    collectorConfigRevision = configRevision;
    const collecting = subscriptions;
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
          if (collecting.every(spec => !configuredKeys.has(spec.key) || recovered.has(spec.key))) {
            clearTimeout(watchdog); failures = 0;
          }
        } else if (packet.type === 'error' && collectorConfigRevision === configRevision) {
          console.error(`${packet.scope}: ${packet.reason}`);
          log('source_error', packet);
          health.requestCheck();
          if (packet.fatal) {
            if (packet.reason.includes('Account does not support this timeframe')) fatal(new Error(packet.reason));
            else sourceError = packet.reason;
          }
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
      console.log(`Disconnected; next in-session connection in ${delay / 1000}s. Unprocessed signals since today's open will be recovered.`);
    });
    collector.send({ subscriptions: collecting, session: activeSession });
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
        // If the next session opens immediately at the previous cutoff, let
        // that live stream finish its normal closing-boundary grace first.
        if (child && activeSession && now <= activeSession.end + CLOSE_GRACE_MS) return;
        deliveries.clear();
        await stopChild();
        await deliveries.active;
        if (stopping) return;
        activeSession = session;
        store.useDay(session.day);
        snapshots = {}; dirty = false;
        sheetDay = null; nextSheetCleanup = 0;
      }
      // Cleanup shares the delivery queue so it cannot race a signal append.
      // It also runs while TradingView is waiting for login or market open.
      queueSheetCleanup(session, now);
      await health.poll(now);
      if (stopping) return;
      if (!health.canCollect) {
        nextConnect = 0;
        sourceError = null;
        if (child) {
          saveSnapshot();
          deliveries.clear();
          await stopChild();
          health.notices();
        }
        return;
      }
      // Keep unchanged streams alive for their final closing-boundary grace.
      // Removed keys are already blocked from both evaluation and delivery.
      const closing = Date.now() >= session.end && Date.now() <= session.end + CLOSE_GRACE_MS;
      if (child && collectorConfigRevision !== configRevision && (!closing || inspect || !subscriptions.length)) {
        console.log('Sheet instruments changed; refreshing the collector.');
        saveSnapshot();
        await stopChild();
        if (stopping) return;
        nextConnect = 0;
      }
      if (sourceError && health.state.status === 'healthy') {
        fatal(new Error(`${sourceError}. Authentication is valid; check the Sheet/account permissions before restarting.`));
        return;
      }
      if (child && collectorRevision !== health.revision) {
        console.log('Saved TradingView session changed; reconnecting.');
        saveSnapshot();
        await stopChild();
        nextConnect = 0;
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
      if (!child && subscriptions.length && (active || inspect) && now >= nextConnect) connect();
    } catch (error) { fatal(error); }
    finally { reconciling = false; }
  }
  const interrupt = () => { void shutdown(); };
  const configTick = setInterval(pollConfig, configPollMs);
  const tick = setInterval(reconcile, 1000);
  const flush = setInterval(() => { try { saveSnapshot(); } catch (error) { fatal(error); } }, 5000);
  const limit = seconds ? setTimeout(interrupt, seconds * 1000) : undefined;
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  console.log(`Watching Sheet instruments every ${configPollMs / 1000}s.${subscriptions.length ? '' : ' No active instruments; waiting for Sheet edits.'}`);
  reconcile();
  await done;
}
