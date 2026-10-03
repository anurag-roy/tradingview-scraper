const element = id => document.getElementById(id);
const csrf = document.querySelector('meta[name="csrf-token"]').content;
// Both older noVNC versions (root-relative paths) and newer ones (paths
// relative to vnc.html) resolve this to /desktop/websockify.
const desktopUrl = '/desktop/vnc.html?resize=scale&path=..%2Fdesktop%2Fwebsockify';
let busy = false;
let polling = false;
let status;
let connectionError = false;

function render(data) {
  status = data;
  const labels = { idle: 'Closed', starting: 'Opening', open: 'Open', stopping: 'Closing', saved: 'Saved',
    failed: 'Needs attention', cancelled: 'Closed', healthy: 'Session valid', unavailable: 'Check unavailable',
    'login-required': 'Sign-in needed', checking: 'Checking', unknown: 'Status unavailable' };
  for (const [name, state] of [['login', data.login], ['monitor', data.monitor]]) {
    element(`${name}-status`).textContent = labels[state.status] || 'Unknown';
    element(`${name}-status`).dataset.state = state.status;
    element(`${name}-message`).textContent = state.message || '';
  }
  element('checked-at').textContent = data.monitor.lastCheckedAt
    ? `Last checked ${new Date(data.monitor.lastCheckedAt).toLocaleString()}` : '';
  const running = ['starting', 'open', 'stopping'].includes(data.login.status);
  element('start').disabled = busy || running;
  element('stop').disabled = busy || !running || data.login.status === 'stopping';
  element('fresh').disabled = busy || running;
  element('desktop-section').hidden = !data.login.desktopReady;
  if (data.login.desktopReady && !element('desktop').firstChild) {
    const frame = document.createElement('iframe');
    frame.title = 'TradingView browser on the VPS';
    frame.src = desktopUrl;
    element('desktop').append(frame);
    element('desktop-link').href = desktopUrl;
  } else if (!data.login.desktopReady) { element('desktop').replaceChildren(); }
}

async function refresh() {
  if (polling || busy || document.hidden) return;
  polling = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read status. Check your Tailscale connection and reload this page.');
    render(await response.json());
    if (connectionError) { element('error').textContent = ''; connectionError = false; }
  } catch (error) { connectionError = true; element('error').textContent = error.message; }
  finally { polling = false; }
}

async function action(route, body = {}) {
  if (busy) return;
  busy = true;
  if (status) render(status);
  element('error').textContent = '';
  connectionError = false;
  try {
    const response = await fetch(route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not complete the request.');
  } catch (error) { element('error').textContent = error.message; }
  finally { busy = false; await refresh(); if (status) render(status); }
}
element('start').addEventListener('click', () => { void action('/api/start', { fresh: element('fresh').checked }); });
element('stop').addEventListener('click', () => { void action('/api/stop'); });
document.addEventListener('visibilitychange', () => { void refresh(); });
setInterval(() => { void refresh(); }, 2000);
void refresh();
