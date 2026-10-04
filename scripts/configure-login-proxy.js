import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readLoginSettings } from '../src/login-settings.js';

process.umask(0o077);
const root = new URL('../', import.meta.url);
const { values } = parseArgs({ options: { 'http-only': { type: 'boolean', default: false } } });

async function writePrivate(file, contents) {
  const temporary = new URL(`${file}.${randomBytes(8).toString('hex')}.tmp`, root);
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, new URL(file, root));
  } finally { await fs.rm(temporary, { force: true }); }
}

try {
  if (process.getuid?.() === 0) throw new Error('Run npm run login:proxy as ubuntu, without sudo.');
  const envFile = await fs.readFile(new URL('.env', root), 'utf8');
  const token = process.env.LOGIN_PROXY_TOKEN || randomBytes(32).toString('hex');
  const settings = readLoginSettings({ env: { ...process.env, LOGIN_PROXY_TOKEN: token } });
  const host = new URL(settings.origin).hostname;
  if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(host)) throw new Error('Use a public IP address or DNS hostname for LOGIN_PUBLIC_URL.');

  let configuration = await fs.readFile(new URL('deploy/tradingview-login.nginx.conf', root), 'utf8');
  if (values['http-only']) configuration = configuration.split('# HTTPS configuration')[0];
  for (const [name, value] of Object.entries({
    LOGIN_HOST: host, LOGIN_ORIGIN: settings.origin, LOGIN_PORT: String(settings.publicPort), LOGIN_PROXY_TOKEN: token,
  })) configuration = configuration.replaceAll(`__${name}__`, value);

  const updatedEnv = /^LOGIN_PROXY_TOKEN=.*$/m.test(envFile)
    ? envFile.replace(/^LOGIN_PROXY_TOKEN=.*$/gm, `LOGIN_PROXY_TOKEN=${token}`)
    : `${envFile.trimEnd()}\nLOGIN_PROXY_TOKEN=${token}\n`;
  await fs.mkdir(new URL('.auth/', root), { recursive: true, mode: 0o700 });
  await writePrivate('.env', updatedEnv);
  await writePrivate('.auth/tradingview-login.nginx.conf', configuration);
  console.log(`Wrote private Nginx configuration to ${fileURLToPath(new URL('.auth/tradingview-login.nginx.conf', root))}.`);
  console.log(values['http-only']
    ? 'Install it to serve certificate challenges, then request the HTTPS certificate. See SETUP.md.'
    : 'Install it, run nginx -t, reload Nginx, and restart tradingview-login. See SETUP.md.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
