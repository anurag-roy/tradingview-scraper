import { parseArgs } from 'node:util';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { AUTH_DIRECTORY, ORIGIN, SESSION_PATH, getQuoteToken, prepareAuthDirectory, saveSession } from './auth.js';
import { createConfigReader, hasSheetConfig } from './sheets.js';

// The browser profile contains login state too, so make newly created files private.
process.umask(0o077);
let browser;
let cancelled = false;
const cancel = () => { cancelled = true; };
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

try {
  const { values } = parseArgs({ options: {
    timeout: { type: 'string', default: '1200' },
    config: { type: 'string', default: hasSheetConfig() ? 'sheet' : 'local' },
    fresh: { type: 'boolean', default: false },
  } });
  if (!['sheet', 'local'].includes(values.config)) throw new Error('--config must be sheet or local');
  let username = process.env.TRADINGVIEW_USERNAME;
  let password = process.env.TRADINGVIEW_PASSWORD;
  if (values.config === 'sheet') {
    const config = await (await createConfigReader()).read();
    if (Boolean(config.credentials.username) !== Boolean(config.credentials.password)) throw new Error('Fill both email and password in the config sheet, or leave both blank to use .env.');
    if (config.credentials.username) ({ username, password } = config.credentials);
  }
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) throw new Error('--timeout must be 30..3600 seconds');
  await prepareAuthDirectory();
  const browserEnv = { ...process.env };
  for (const key of Object.keys(browserEnv)) {
    if (key.startsWith('TRADINGVIEW_') || key.startsWith('GOOGLE_')) delete browserEnv[key];
  }
  browser = await puppeteer.launch({
    headless: false, defaultViewport: null,
    userDataDir: path.join(AUTH_DIRECTORY, 'browser'),
    ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
    env: browserEnv, args: ['--start-maximized'],
    handleSIGINT: false, handleSIGTERM: false,
  });
  if (values.fresh) {
    const context = browser.defaultBrowserContext();
    const cookies = (await context.cookies()).filter(c => /(^|\.)tradingview\.com$/.test(c.domain));
    if (cookies.length) await context.deleteCookie(...cookies);
    console.log('Starting a fresh TradingView sign-in in this scraper’s browser profile.');
  }
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto(ORIGIN + '/#signin', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.bringToFront();
  console.log('Chrome is open. Complete TradingView sign-in and any CAPTCHA/2FA in that window.');
  console.log('Waiting for a working session; cookies and tokens will not be printed.');

  const deadline = Date.now() + timeout * 1000;
  let filled = false;
  let nextValidation = 0;
  let validationMessage;
  let saved = false;
  while (Date.now() < deadline && !cancelled && browser.connected) {
    // Fill only TradingView's own visible email/password form, once. The user submits it.
    if (!filled && !page.isClosed() && new URL(page.url()).origin === ORIGIN
        && username && password) {
      const usernameSelector = 'input[name="id_username"], input[name="username"]';
      const passwordSelector = 'input[name="id_password"], input[name="password"]';
      const usernameInput = await page.$(usernameSelector);
      const passwordInput = await page.$(passwordSelector);
      try {
        if (usernameInput && passwordInput && await usernameInput.isVisible() && await passwordInput.isVisible()) {
          const currentUsername = await usernameInput.evaluate(input => input.value);
          const emptyPassword = await passwordInput.evaluate(input => input.value === '');
          if ((!currentUsername || currentUsername === username) && emptyPassword) {
            if (!currentUsername) await page.locator(usernameSelector).fill(username);
            await page.locator(passwordSelector).fill(password);
            console.log('Filled the configured login credentials. Submit the form when ready.');
          }
          filled = true;
        }
      } finally {
        await usernameInput?.dispose();
        await passwordInput?.dispose();
      }
    }
    const cookies = await browser.defaultBrowserContext().cookies();
    const tvCookies = cookies.filter(c => ['.tradingview.com', 'tradingview.com', 'www.tradingview.com'].includes(c.domain));
    const sessionid = tvCookies.find(c => c.name === 'sessionid');
    if (sessionid && Date.now() >= nextValidation) {
      nextValidation = Date.now() + 15_000;
      const session = {
        sessionid: sessionid.value,
        sessionid_sign: tvCookies.find(c => c.name === 'sessionid_sign')?.value || '',
        cookieExpiresAt: sessionid.expires > 0 ? new Date(sessionid.expires * 1000).toISOString() : null,
        userAgent: await browser.userAgent(),
      };
      try {
        await getQuoteToken(session);
        await saveSession(session);
        console.log('Login verified. Saved session to ' + SESSION_PATH);
        console.log('The scraper can now reuse it: npm run snapshot -- --study');
        saved = true;
        break;
      } catch (error) {
        if (error.message !== validationMessage) {
          validationMessage = error.message;
          console.log('Still waiting for a usable session: ' + error.message);
        }
      }
    }
    await delay(1000);
  }
  if (!saved) throw new Error(cancelled ? 'Login cancelled.' : 'Login ended without a verified session. Run npm run login to continue.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  await browser?.close();
}
