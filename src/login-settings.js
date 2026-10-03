export function publicLoginOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set LOGIN_PUBLIC_URL to the HTTPS Tailscale Serve origin.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.port ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('LOGIN_PUBLIC_URL must be the HTTPS Tailscale Serve origin, for example https://vps.example.ts.net.');
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
  const allowedEmail = env.LOGIN_ALLOWED_EMAIL?.trim();
  if (!local) {
    origin = publicLoginOrigin(env.LOGIN_PUBLIC_URL || '');
    if (!allowedEmail) throw new Error('Set LOGIN_ALLOWED_EMAIL to your Tailscale sign-in email.');
  }
  return { local, publicPort, desktopPort, vncPort, timeout, origin, allowedEmail };
}
