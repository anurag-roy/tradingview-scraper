import TradingView from '@mathieuc/tradingview';
import { authenticate } from './auth.js';
import { normalizeBar } from './candles.js';
import { insideSession } from './session.js';

// Isolate the dependency's socket lifecycle. Its end() resolves before close
// and cannot cancel a connecting socket; the parent can always stop this child.
let client;
let stopping = false;
const publish = packet => { if (process.connected && !stopping) process.send(packet); };
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(code), 1000);
  if (client) void client.end();
  else process.exit(code);
}
function fail(scope, reason, fatal = false) {
  publish({ type: 'error', scope, reason, fatal });
  stop(1);
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('disconnect', () => stop());
process.on('uncaughtException', () => fail('worker', 'Unexpected collector error'));
process.on('unhandledRejection', () => fail('worker', 'Unexpected collector rejection'));

process.once('message', async ({ subscriptions, session }) => {
  const started = Date.now();
  let auth;
  try { auth = await authenticate('session'); }
  catch (error) { fail('authentication', error.message, true); return; }
  let indicator;
  try {
    indicator = await TradingView.getIndicator('PUB;b1702429dc1f4ab0a2cbdf51fd796448', '1.0',
      auth.clientOptions.token, auth.clientOptions.signature);
  } catch { fail('indicator', 'Could not load LuxAlgo 1.0 metadata'); return; }
  if (stopping) return;
  client = new TradingView.Client(auth.clientOptions);
  let lastTransport = Date.now();
  const states = [];
  client.onPing(() => { lastTransport = Date.now(); });
  client.onData(() => { lastTransport = Date.now(); });
  client.onConnected(() => publish({ type: 'connected' }));
  client.onDisconnected(() => {
    if (stopping) process.exit(0);
    else fail('connection', 'TradingView disconnected');
  });
  client.onError(() => fail('connection', 'TradingView socket or session error; refresh login if this persists'));

  for (const spec of subscriptions) {
    const chart = new client.Session.Chart();
    const state = { ...spec, chart, study: null, ready: false, queued: false, announced: false, lagSince: null };
    states.push(state);
    const emit = () => {
      state.queued = false;
      if (stopping || !state.ready || !chart.periods.length) return;
      const bars = chart.periods.map(normalizeBar);
      const studies = state.study.periods;
      const latestNative = bars[0].time;
      const latestStudy = studies[0]?.$time ?? 0;
      const duration = Number(spec.timeframe) * 60;
      const latestClosed = bars.find(bar => bar.time < latestNative && (bar.time + duration) * 1000 <= Date.now());
      const pocByTime = new Map(studies.map(row => [row.$time, row.plotcandle_2_ohlc_close]));
      const rows = bars.filter(bar => insideSession(bar, spec.timeframe, session)).reverse().map(bar => ({
        ...bar, poc: Number.isFinite(pocByTime.get(bar.time)) ? pocByTime.get(bar.time) : null,
        confirmed: bar.time < latestNative && latestStudy >= bar.time + duration &&
          (bar.time + duration) * 1000 <= Date.now(),
      }));
      const lagging = latestClosed && latestStudy < latestClosed.time + duration;
      state.lagSince = lagging ? state.lagSince ?? Date.now() : null;
      publish({ type: 'snapshot', key: spec.key, symbol: spec.symbol, timeframe: spec.timeframe,
        rows, latestClosedTime: latestClosed?.time ?? null,
        historyCovered: bars.at(-1).time * 1000 <= session.start,
        pricescale: chart.infos.pricescale, provider: chart.infos.provider_id,
        resolvedSymbol: chart.infos.full_name,
        receivedAt: Date.now(), initial: !state.announced, loadMs: Date.now() - started });
      state.announced = true;
    };
    const schedule = () => {
      lastTransport = Date.now();
      if (state.queued || stopping) return;
      state.queued = true;
      // Coalesce native and study callbacks from the same packet, without
      // polling or adding a candle-close delay.
      setImmediate(emit);
    };
    const upstreamError = scope => (...details) => {
      const custom = details.some(value => typeof value === 'string' && value.includes('custom_resolution'));
      fail(`${spec.symbol} ${spec.timeframe}m ${scope}`, custom
        ? 'Account does not support this timeframe; change the Sheet interval'
        : 'TradingView rejected the chart/study request', true);
    };
    chart.onError(upstreamError('chart'));
    chart.onUpdate(schedule);
    // More than a full calendar day, including a bar before the session. The
    // monitor retains only candles fully inside its own monitoring window.
    chart.setMarket(spec.symbol, { timeframe: spec.timeframe, range: Math.ceil(1440 / Number(spec.timeframe)) + 10 });
    state.study = new chart.Study(indicator);
    state.study.onError(upstreamError('study'));
    state.study.onReady(() => { state.ready = true; schedule(); });
    state.study.onUpdate(schedule);
  }
  setInterval(() => {
    const now = Date.now();
    if (now - lastTransport > 90_000) fail('connection', 'No TradingView traffic for 90 seconds');
    else if (states.some(state => !state.announced) && now - started > 120_000) {
      fail('history', 'Not all chart/study histories loaded within 120 seconds');
    } else if (states.some(state => state.lagSince && now - state.lagSince > 90_000)) {
      fail('study', 'LuxAlgo study has not confirmed native closes for 90 seconds');
    }
  }, 5000);
});
