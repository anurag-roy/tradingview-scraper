export function publicLoginOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set LOGIN_PUBLIC_URL to the public HTTPS origin.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.port ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('LOGIN_PUBLIC_URL must be an HTTPS origin without a port, path, query, or fragment, for example https://203.0.113.10.');
  }
  return url.origin;
}

export function readLoginSettings({ local = false, env = process.env } = {}) {
  const port = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be 1024..65535.`);
    return value;
  };
  const publicPort = port('LOGIN_PORT', 6080);
  const desktopPort = port('LOGIN_DESKTOP_PORT', 6081);
  const vncPort = port('LOGIN_VNC_PORT', 5901);
  if (new Set([publicPort, desktopPort, vncPort]).size !== 3) throw new Error('Login ports must be different.');
  const timeout = Number(env.LOGIN_TIMEOUT_SECONDS || 1200);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600) throw new Error('LOGIN_TIMEOUT_SECONDS must be 30..3600.');
  if (env.TRADINGVIEW_SESSION) throw new Error('Remove TRADINGVIEW_SESSION overrides before using remote login; they override the browser session file.');
  let origin = `http://127.0.0.1:${publicPort}`;
  let proxyToken;
  if (!local) {
    origin = publicLoginOrigin(env.LOGIN_PUBLIC_URL || '');
    if (!/^[a-f0-9]{64}$/i.test(env.LOGIN_PROXY_TOKEN || '')) {
      throw new Error('Generate LOGIN_PROXY_TOKEN and the Nginx configuration with npm run login:proxy. See SETUP.md.');
    }
    proxyToken = Buffer.from(env.LOGIN_PROXY_TOKEN, 'hex');
  }
  return { local, publicPort, desktopPort, vncPort, timeout, origin, proxyToken };
}
