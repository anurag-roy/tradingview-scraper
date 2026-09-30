import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ORIGIN = 'https://www.tradingview.com';
export const AUTH_DIRECTORY = fileURLToPath(new URL('../.auth/', import.meta.url));
export const SESSION_PATH = path.join(AUTH_DIRECTORY, 'session.json');

export async function prepareAuthDirectory() {
  await fs.mkdir(AUTH_DIRECTORY, { recursive: true, mode: 0o700 });
  await fs.chmod(AUTH_DIRECTORY, 0o700);
}

export function sessionCookieHeader(session) {
  const cookies = [['sessionid', session.sessionid], ['sessionid_sign', session.sessionid_sign]];
  if (!session.sessionid) throw new Error('Missing TradingView session. Run npm run login.');
  for (const [, value] of cookies) {
    if (value && (typeof value !== 'string' || /[;\r\n]/.test(value))) {
      throw new Error('Invalid TradingView session cookie. Run npm run login.');
    }
  }
  return cookies.filter(([, value]) => value).map(([name, value]) => name + '=' + value).join('; ');
}

/** Refresh the short-lived WebSocket token using the browser's session cookies. */
export async function getQuoteToken(session) {
  const cookie = sessionCookieHeader(session);
  let response;
  try {
    response = await fetch(ORIGIN + '/quote_token/', {
      method: 'POST', body: '', redirect: 'error',
      headers: {
        Cookie: cookie, Origin: ORIGIN, Referer: ORIGIN + '/',
        'User-Agent': session.userAgent || 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Could not reach TradingView quote_token. Check the connection and retry.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('TradingView quote_token HTTP ' + response.status + '. Run npm run login to refresh the session.');
  }
  const body = (await response.text()).trim();
  let token = body;
  try { token = JSON.parse(body); } catch { /* Some responses use an unquoted JWT. */ }
  if (typeof token !== 'string') throw new Error('TradingView returned an unexpected quote token response.');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('TradingView did not return a quote token. Run npm run login.');
  }
  return token;
}

export async function saveSession(session) {
  await prepareAuthDirectory();
  const temporary = SESSION_PATH + '.' + process.pid + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...session }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, SESSION_PATH);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function authenticate(mode, env = process.env) {
  if (mode === 'anonymous') return { mode, clientOptions: {} };
  if (mode !== 'session') throw new Error('Auth must be session or anonymous. Use npm run login for browser sign-in.');
  let session;
  if (env.TRADINGVIEW_SESSION) {
    session = { sessionid: env.TRADINGVIEW_SESSION, sessionid_sign: env.TRADINGVIEW_SESSION_SIGN || '' };
  } else {
    try {
      session = JSON.parse(await fs.readFile(SESSION_PATH, 'utf8'));
    } catch {
      throw new Error('No readable saved TradingView session. Run npm run login.');
    }
  }
  sessionCookieHeader(session);
  const quoteToken = await getQuoteToken(session);
  return {
    mode, quoteToken,
    clientOptions: { token: session.sessionid, signature: session.sessionid_sign || '', location: ORIGIN + '/' },
  };
}
