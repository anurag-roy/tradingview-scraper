import http from 'node:http';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readLoginSettings } from './login-settings.js';
import { LoginController } from './login-controller.js';
import { proxyDesktop, proxyDesktopSocket } from './desktop-proxy.js';

process.umask(0o077);
const { values } = parseArgs({ options: { local: { type: 'boolean', default: false } } });
const settings = readLoginSettings({ local: values.local });
const controller = new LoginController(settings);
const csrfToken = randomBytes(32).toString('hex');
const desktopSockets = new Set();
const assets = new Map();
for (const [route, file, type] of [
  ['/', 'login.html', 'text/html; charset=utf-8'],
  ['/assets/login.css', 'login.css', 'text/css; charset=utf-8'],
  ['/assets/login.js', 'login.js', 'text/javascript; charset=utf-8'],
]) {
  const content = (await fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')).replace('{{CSRF_TOKEN}}', csrfToken);
  assets.set(route, { content, type });
}

function authorized(request) {
  return settings.local || request.headers['tailscale-user-login'] === settings.allowedEmail;
}
function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
async function healthSummary() {
  try {
    const state = JSON.parse(await fs.readFile(new URL('../.state/live/session-health.json', import.meta.url), 'utf8'));
    return { status: state.status, message: state.message, lastCheckedAt: state.lastCheckedAt };
  } catch { return { status: 'unknown', message: 'No monitor status yet. Start the monitor service after setup.' }; }
}
async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1024) throw new Error('Request too large.');
  }
  return JSON.parse(body || '{}');
}
function desktopPath(url) {
  return url.pathname.slice('/desktop'.length) + url.search;
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (!authorized(request)) { reply(response, 403, { error: 'Access requires the configured Tailscale account.' }); return; }
  try {
    const url = new URL(request.url, settings.origin);
    if (request.method === 'GET' && assets.has(url.pathname)) {
      const asset = assets.get(url.pathname);
      response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.content); return;
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      reply(response, 200, { login: controller.state, monitor: await healthSummary() }); return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/desktop/')) {
      if (!controller.state.desktopReady) { reply(response, 409, { error: 'Start a login session first.' }); return; }
      proxyDesktop(request, response, { port: settings.desktopPort, path: desktopPath(url) }); return;
    }
    if (request.method === 'POST' && ['/api/start', '/api/stop'].includes(url.pathname)) {
      if (request.headers.origin !== settings.origin || request.headers['x-csrf-token'] !== csrfToken ||
        !request.headers['content-type']?.startsWith('application/json')) {
        reply(response, 403, { error: 'Reload the login page before continuing.' }); return;
      }
      const body = await readBody(request);
      if (url.pathname === '/api/start') {
        if (body.fresh !== undefined && typeof body.fresh !== 'boolean') throw new Error('Invalid login option.');
        await controller.start(body.fresh === true);
      } else { await controller.stop(); }
      reply(response, 200, { login: controller.state }); return;
    }
    reply(response, 404, { error: 'Not found.' });
  } catch (error) { reply(response, 400, { error: error.message === 'Unexpected end of JSON input' ? 'Invalid request.' : error.message }); }
});
server.requestTimeout = 15_000;
server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, settings.origin);
    if (!authorized(request) || request.headers.origin !== settings.origin || !controller.state.desktopReady ||
      url.pathname !== '/desktop/websockify' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    proxyDesktopSocket(request, socket, head, { port: settings.desktopPort, path: desktopPath(url), sockets: desktopSockets });
  } catch { socket.destroy(); }
});
controller.on('change', () => {
  if (!controller.state.desktopReady) for (const socket of desktopSockets) socket.destroy();
});
server.listen(settings.publicPort, '127.0.0.1', () => {
  console.log(`Login page: ${settings.origin} (listening only on 127.0.0.1:${settings.publicPort})`);
  if (settings.local) console.log('Local mode: for this computer only. Do not expose this mode through a proxy.');
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  controller.closing = true;
  server.close();
  server.closeAllConnections();
  for (const socket of desktopSockets) socket.destroy();
  await controller.stop();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
