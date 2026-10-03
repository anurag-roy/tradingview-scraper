import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ORIGIN = 'https://www.tradingview.com';
export const AUTH_DIRECTORY = fileURLToPath(new URL('../.auth/', import.meta.url));
export const SESSION_PATH = path.join(AUTH_DIRECTORY, 'session.json');

export class AuthenticationError extends Error {
  constructor(message, code = 'UPSTREAM_UNAVAILABLE') {
    super(message);
    this.code = code;
  }
}

export async function readSavedSession(env = process.env) {
  if (env.TRADINGVIEW_SESSION) {
    return { sessionid: env.TRADINGVIEW_SESSION, sessionid_sign: env.TRADINGVIEW_SESSION_SIGN || '' };
  }
  try {
    const session = JSON.parse(await fs.readFile(SESSION_PATH, 'utf8'));
    sessionCookieHeader(session);
    return session;
  } catch {
    throw new AuthenticationError('No usable saved TradingView session. Complete browser login.', 'LOGIN_REQUIRED');
  }
}

export async function prepareAuthDirectory() {
  await fs.mkdir(AUTH_DIRECTORY, { recursive: true, mode: 0o700 });
  await fs.chmod(AUTH_DIRECTORY, 0o700);
}

export function sessionCookieHeader(session) {
  if (!session || typeof session !== 'object' || !session.sessionid) {
    throw new AuthenticationError('Missing TradingView session. Complete browser login.', 'LOGIN_REQUIRED');
  }
  const cookies = [['sessionid', session.sessionid], ['sessionid_sign', session.sessionid_sign]];
  for (const [, value] of cookies) {
    if (value && (typeof value !== 'string' || /[;\r\n]/.test(value))) {
      throw new AuthenticationError('Invalid TradingView session cookie. Complete browser login.', 'LOGIN_REQUIRED');
    }
  }
  return cookies.filter(([, value]) => value).map(([name, value]) => name + '=' + value).join('; ');
}

/** Refresh the short-lived WebSocket token using the browser's session cookies. */
export async function getQuoteToken(session, { signal } = {}) {
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
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AuthenticationError('Could not reach TradingView. Authentication will be checked again.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AuthenticationError('TradingView authentication HTTP ' + response.status + '.',
      response.status === 401 ? 'LOGIN_REQUIRED' : 'UPSTREAM_UNAVAILABLE');
  }
  const body = (await response.text()).trim();
  let token = body;
  try { token = JSON.parse(body); } catch { /* Some responses use an unquoted JWT. */ }
  if (token === 'unauthorized_user_token') {
    throw new AuthenticationError('TradingView no longer recognizes this session. Complete browser login.', 'LOGIN_REQUIRED');
  }
  if (typeof token !== 'string') throw new AuthenticationError('TradingView returned an unexpected authentication response.');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new AuthenticationError('TradingView did not return a usable quote token. Authentication will be checked again.');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new AuthenticationError('TradingView returned an unreadable quote token.'); }
  if (!claims || typeof claims !== 'object') throw new AuthenticationError('TradingView returned an unexpected quote token.');
  // The token comes directly from TradingView over HTTPS. Check the account
  // claim, not just JWT syntax: anonymous chart access is not a valid login.
  if (Number.isInteger(claims.user_id) && claims.user_id <= 0) {
    throw new AuthenticationError('TradingView returned an anonymous session. Complete browser login.', 'LOGIN_REQUIRED');
  }
  if (!Number.isInteger(claims.user_id) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
    throw new AuthenticationError('TradingView returned an unexpected or expired quote token. Authentication will be checked again.');
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

export async function authenticate(mode, env = process.env, options = {}) {
  if (mode === 'anonymous') return { mode, clientOptions: {} };
  if (mode !== 'session') throw new Error('Auth must be session or anonymous. Use npm run login for browser sign-in.');
  const session = options.session || await readSavedSession(env);
  sessionCookieHeader(session);
  const quoteToken = await getQuoteToken(session, options);
  return {
    mode, quoteToken,
    clientOptions: { token: session.sessionid, signature: session.sessionid_sign || '', location: ORIGIN + '/' },
  };
}
