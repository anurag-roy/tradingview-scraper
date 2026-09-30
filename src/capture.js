import fs from 'node:fs';
import path from 'node:path';
import TradingView from '@mathieuc/tradingview';
import { joinCandles, normalizeBar } from './candles.js';
import { subscriptionsFor } from './config.js';

export function statistics(values) {
  if (!values.length) return { count: 0, min: null, median: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = q => sorted[Math.ceil(q * sorted.length) - 1];
  return { count: values.length, min: sorted[0], median: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) };
}

/** Bounded PoC capture. Disconnects/errors are reported, never silently retried. */
export async function capture({ instruments, symbol, timeframes, history, seconds, output, auth, study: useStudy = true }) {
  const subscriptions = subscriptionsFor(instruments || [{ slot: null, symbol, timeframes }]);
  if (!subscriptions.length) throw new Error('No active instrument/timeframe subscriptions.');
  const symbols = [...new Set(subscriptions.map(s => s.symbol))];
  const requested = new Set(subscriptions.map(s => s.key));
  const chartSpecs = new Map(subscriptions.map(s => [s.key, s]));
  for (const symbol of symbols) {
    const key = `${symbol}|1`;
    if (!chartSpecs.has(key)) chartSpecs.set(key, { key, symbol, timeframe: '1' });
  }
  fs.mkdirSync(output, { recursive: true });
  const eventPath = path.join(output, 'events.jsonl');
  fs.writeFileSync(eventPath, '');
  const log = event => fs.appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
  const started = Date.now();
  const states = new Map();
  const errors = [];
  const emitted = new Map();
  let firstCompleteMs = null;
  let connectedMs = null;
  let serverClockDifferenceMs = null;
  let finishing = false;
  const client = new TradingView.Client(auth.clientOptions);
  let finish;
  let finishRequested = false;
  const stop = () => finish ? finish() : (finishRequested = true);
  const recordError = (scope, details) => {
    // Only strings from known callback errors; redact any configured secrets.
    let message = details.map(x => typeof x === 'string' ? x : (x?.error || x?.message || 'upstream error')).join(' ');
    for (const secret of [process.env.TRADINGVIEW_USERNAME, process.env.TRADINGVIEW_PASSWORD, auth.clientOptions.token, auth.clientOptions.signature, auth.quoteToken]) {
      if (secret) message = message.replaceAll(secret, '[redacted]');
    }
    if (message.includes('custom_resolution')) message += '; TradingView rejected this custom timeframe for the current account. Choose an available chart interval in the config sheet.';
    errors.push({ scope, message });
    console.error(`${scope}: ${message}`);
    log({ type: 'error', scope, message, receivedAt: new Date().toISOString() });
  };
  client.onError((...details) => { recordError('connection', details); stop(); });
  client.onConnected(() => { connectedMs = Date.now() - started; });
  client.onDisconnected(() => {
    if (!finishing) { recordError('connection', ['Unexpected disconnect; capture stopped']); stop(); }
  });
  client.onData(packet => {
    if (Number.isFinite(packet.timestampMs)) serverClockDifferenceMs = packet.timestampMs - Date.now();
  });
  let indicator;
  if (useStudy) {
    try {
      indicator = await TradingView.getIndicator('PUB;b1702429dc1f4ab0a2cbdf51fd796448', '1.0', auth.clientOptions.token, auth.clientOptions.signature);
    } catch {
      recordError('indicator', ['Could not load LuxAlgo 1.0 metadata']);
      await client.end();
      throw new Error('Indicator metadata unavailable');
    }
  }
  const snapshot = () => {
    return subscriptions.map(({ key, symbol, timeframe, slots }) => {
      const minutes = states.get(`${symbol}|1`)?.chart.periods.map(normalizeBar) || [];
      const state = states.get(key);
      const studyPeriods = state?.study?.periods || [];
      const studyByTime = new Map(studyPeriods.map(p => [p.$time, p.plotcandle_2_ohlc_close]));
      const nativeBars = state?.chart.periods.map(normalizeBar) || [];
      const latestNativeTime = nativeBars[0]?.time ?? -Infinity;
      const latestStudyTime = studyPeriods[0]?.$time ?? -Infinity;
      const rows = joinCandles(nativeBars, minutes, timeframe, symbol);
      return {
        symbol, timeframe, slots, resolvedSymbol: state?.chart.infos.full_name,
        provider: state?.chart.infos.provider_id, exchangeTimezone: state?.chart.infos.timezone,
        rows: rows.map(row => {
          if (!useStudy) return row;
          const value = studyByTime.get(row.time);
          const poc = Number.isFinite(value) ? value : null;
          const closed = row.time < latestNativeTime;
          const studyClosed = latestStudyTime >= row.time + Number(timeframe) * 60;
          const validOhlcv = ['open', 'high', 'low', 'close', 'volume'].every(key => Number.isFinite(row[key]));
          return {
            ...row, state: closed ? 'closed' : 'unconfirmed',
            localPoc: row.poc, localPocStatus: row.pocStatus,
            localSignalEligible: row.signalEligible,
            localPocMatchesStudy: Number.isFinite(row.poc) && poc !== null ? Math.abs(row.poc - poc) < 0.000001 : null,
            poc, tradingViewStudyPoc: poc,
            pocSource: 'tradingview-luxalgo-volume-delta-candles-1.0',
            pocStatus: poc === null ? 'awaiting-study' : !closed ? 'provisional' : !studyClosed ? 'awaiting-study-close' : 'ok',
            signalEligible: closed && studyClosed && validOhlcv && poc !== null,
          };
        }),
      };
    });
  };
  const detectClosed = now => {
    if ([...states.values()].some(state => state.firstDataMs === null)) return;
    const data = snapshot();
    if (firstCompleteMs === null && data.every(group => group.rows.some(row => row.signalEligible))) {
      firstCompleteMs = now - started;
      console.log(`All intervals have verified closed candles after ${firstCompleteMs} ms`);
    }
    for (const group of data) {
      for (const row of group.rows) {
        if (!row.signalEligible || Date.parse(row.closeTimeUtc) <= started) continue;
        const key = `${row.symbol}|${row.timeframe}|${row.time}`;
        const signature = JSON.stringify([row.open, row.high, row.low, row.close, row.volume, row.poc]);
        if (emitted.get(key) === signature) continue;
        const type = emitted.has(key) ? 'closed_candle_revision' : 'closed_candle';
        emitted.set(key, signature);
        const delayMs = now - Date.parse(row.closeTimeUtc);
        log({ type, receivedAt: new Date(now).toISOString(), boundaryDelayMs: delayMs, row });
        if (type === 'closed_candle') states.get(`${group.symbol}|${group.timeframe}`).verifiedCloseDelaysMs.push(delayMs);
        console.log(`${type}: ${row.symbol} ${row.timeframe}m ${row.timeIst} POC=${row.poc} boundary delay=${delayMs} ms`);
      }
    }
  };
  for (const { key, symbol, timeframe } of chartSpecs.values()) {
    const chart = new client.Session.Chart();
    const state = {
      symbol, timeframe, chart, firstDataMs: null, lastUpdateAt: null, fingerprint: null,
      updateIntervalsMs: [], rolloverDelaysMs: [], verifiedCloseDelaysMs: [], updates: 0,
      studyFirstDataMs: null, studyUpdates: 0, studyUpdateIntervalsMs: [], studyFingerprint: null,
    };
    states.set(key, state);
    chart.onError((...details) => { recordError(`${symbol} ${timeframe}m chart`, details); stop(); });
    chart.onUpdate(changes => {
      if (finishing || !changes.includes('$prices') || !chart.periods.length) return;
      const now = Date.now();
      const bars = chart.periods;
      const fingerprint = JSON.stringify(bars.slice(0, 2));
      if (fingerprint === state.fingerprint) return;
      state.fingerprint = fingerprint;
      const latest = bars[0];
      if (state.firstDataMs === null) {
        state.firstDataMs = now - started;
        console.log(`${symbol} ${timeframe}m: ${bars.length} candles received in ${state.firstDataMs} ms`);
      } else {
        state.updateIntervalsMs.push(now - state.lastUpdateAt);
        if (state.latestTime !== latest.time) state.rolloverDelaysMs.push(now - latest.time * 1000);
      }
      state.latestTime = latest.time;
      state.lastUpdateAt = now;
      state.updates++;
      log({ type: 'chart_update', symbol, timeframe, receivedAt: new Date(now).toISOString(), latest: normalizeBar(latest), count: bars.length });
      detectClosed(now);
    });
    chart.setMarket(symbol, { timeframe, range: timeframe === '1' ? history : Math.min(100, history) });
    if (indicator && requested.has(key)) {
      state.study = new chart.Study(indicator);
      state.study.onError((...details) => { recordError(`${symbol} ${timeframe}m study`, details); stop(); });
      state.study.onUpdate(() => {
        if (finishing || !state.study.periods.length) return;
        const now = Date.now();
        const periods = state.study.periods;
        const fingerprint = JSON.stringify(periods.slice(0, 2));
        if (fingerprint === state.studyFingerprint) return;
        state.studyFingerprint = fingerprint;
        if (state.studyFirstDataMs === null) {
          state.studyFirstDataMs = now - started;
          console.log(`${symbol} ${timeframe}m: ${periods.length} LuxAlgo study rows received in ${state.studyFirstDataMs} ms`);
        } else state.studyUpdateIntervalsMs.push(now - state.studyLastUpdateAt);
        state.studyLastUpdateAt = now;
        state.studyUpdates++;
        log({ type: 'study_update', symbol, timeframe, receivedAt: new Date(now).toISOString(), latest: { time: periods[0].$time, poc: periods[0].plotcandle_2_ohlc_close ?? null }, count: periods.length });
        detectClosed(now);
      });
    }
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(), seconds * 1000);
    const progress = setInterval(() => console.log(`Capturing: ${Math.round((Date.now() - started) / 1000)} s elapsed`), 60_000);
    const interrupt = () => finish();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    finish = async () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer); clearInterval(progress);
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      const data = snapshot();
      const summary = {
        symbols, subscriptions, authMode: auth.mode, pocSource: useStudy ? 'tradingview-study' : 'local-calculation', startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
        connectedMs, firstCompleteMs, serverClockDifferenceMs,
        latencyNote: 'Update gaps and local receipt delay after nominal bar boundaries; not exchange-to-client tick latency. Initial history excluded from close-delay statistics.',
        errors,
        series: [...states.values()].map(state => ({
          symbol: state.symbol, timeframe: state.timeframe, candles: state.chart.periods.length, firstDataMs: state.firstDataMs, updates: state.updates,
          studyCandles: state.study?.periods.length ?? null,
          studyFirstDataMs: state.studyFirstDataMs, studyUpdates: state.studyUpdates,
          studyUpdateIntervalsMs: statistics(state.studyUpdateIntervalsMs),
          updateIntervalsMs: statistics(state.updateIntervalsMs),
          rolloverDelaysMs: statistics(state.rolloverDelaysMs),
          verifiedCloseDelaysMs: statistics(state.verifiedCloseDelaysMs),
          eligibleClosedCandles: data.find(group => group.symbol === state.symbol && group.timeframe === state.timeframe)?.rows.filter(row => row.signalEligible).length ?? null,
        })),
      };
      fs.writeFileSync(path.join(output, 'candles.json'), `${JSON.stringify(data, null, 2)}\n`);
      const columns = ['symbol', 'timeframe', 'timeIst', 'open', 'high', 'low', 'close', 'volume', 'poc', 'pocSource', 'state', 'pocStatus', 'signalEligible'];
      const csvValue = value => value === null || value === undefined ? '' : `"${String(value).replaceAll('"', '""')}"`;
      fs.writeFileSync(path.join(output, 'candles.csv'), `${[
        columns.join(','),
        ...data.flatMap(group => group.rows.map(row => columns.map(key => csvValue(row[key])).join(','))),
      ].join('\n')}\n`);
      const minuteData = symbols.map(symbol => ({ symbol, rows: states.get(`${symbol}|1`).chart.periods.map(normalizeBar) }));
      fs.writeFileSync(path.join(output, 'minutes.json'), `${JSON.stringify(symbols.length === 1 ? minuteData[0].rows : minuteData, null, 2)}\n`);
      fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      // The dependency's end() resolves before the socket's close handshake.
      // An unref'ed watchdog only runs if that socket keeps the CLI alive.
      setTimeout(() => { console.error('Socket did not close within 5s'); process.exit(1); }, 5000).unref();
      await client.end();
      resolve({ summary, data });
    };
    if (finishRequested) finish();
  });
}
