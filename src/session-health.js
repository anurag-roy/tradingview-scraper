import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { authenticate, readSavedSession } from './auth.js';
import { publicLoginOrigin } from './login-settings.js';

export const HEALTH_FILE = 'session-health.json';

export function readHealthSettings(env = process.env) {
  const interval = Number(env.SESSION_CHECK_INTERVAL_SECONDS || 600);
  if (!Number.isInteger(interval) || interval < 30 || interval > 3600) {
    throw new Error('SESSION_CHECK_INTERVAL_SECONDS must be 30..3600.');
  }
  const loginUrl = env.LOGIN_PUBLIC_URL?.trim() ? publicLoginOrigin(env.LOGIN_PUBLIC_URL.trim()) : '';
  return { intervalMs: interval * 1000, loginUrl };
}

/** Authentication state survives day rotation and restarts. Notification
 * reservations use the same one-attempt rule as candle messages. */
export class SessionHealth {
  constructor({ store, deliveries, send, dryRun, settings }) {
    Object.assign(this, { store, deliveries, send, dryRun, settings });
    const file = path.join(store.directory, HEALTH_FILE);
    try {
      this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, status: 'checking', incident: null };
      if (this.state.version !== 1 || !['checking', 'healthy', 'unavailable', 'login-required'].includes(this.state.status)) throw new Error();
    } catch { throw new Error('Session health state is unreadable; inspect session-health.json before restarting.'); }
    this.canCollect = false;
    this.nextCheck = 0;
    this.nextRead = 0;
    this.controller = new AbortController();
  }

  save() { this.store.writeJson(HEALTH_FILE, this.state); }
  requestCheck() { this.nextCheck = 0; this.nextRead = 0; }
  close() { this.closed = true; this.controller.abort(); }

  queueNotice(kind, text) {
    const incident = this.state.incident;
    if (!incident) return;
    const notice = incident[kind] ||= { status: 'queued' };
    if (notice.status !== 'queued') return;
    if (this.dryRun) {
      notice.status = 'dry-run';
      this.save();
      console.log(`[dry-run] ${text}`);
      return;
    }
    const id = `session:${incident.id}:${kind}`;
    this.deliveries.enqueue(id, async () => {
      if (this.closed || this.state.incident !== incident || notice.status !== 'queued') return false;
      if (kind === 'loginNotice' && this.state.status !== 'login-required') {
        notice.status = 'skipped'; this.save(); return false;
      }
      if (kind === 'recoveryNotice' && this.state.status !== 'healthy') return false;
      notice.status = 'attempting';
      notice.attemptedAt = new Date().toISOString();
      this.save();
      const outcome = await this.send(text);
      Object.assign(notice, outcome, { completedAt: new Date().toISOString() });
      this.save();
      this.store.log('session_notification', { kind, ...outcome });
      console.log(`Telegram session notification: ${outcome.status}`);
      return true;
    });
  }

  notices() {
    const incident = this.state.incident;
    if (!incident) return;
    if (this.state.status === 'login-required') {
      this.queueNotice('loginNotice', 'TradingView login required. Signal monitoring is paused.' +
        (this.settings.loginUrl ? `\nEnable Tailscale and open ${this.settings.loginUrl}` : '\nRun npm run login on the scraper computer.'));
    } else if (this.state.status === 'healthy' && incident.recoveredAt) {
      this.queueNotice('recoveryNotice', 'TradingView login restored. The monitor will reconnect automatically during its configured monitoring hours.');
    }
  }

  async poll(now = Date.now()) {
    if (this.closed || now < this.nextRead) return;
    this.nextRead = now + 5000;
    let session;
    let fingerprint = 'missing';
    let readError;
    try {
      session = await readSavedSession();
      fingerprint = createHash('sha256').update(JSON.stringify([
        session.sessionid, session.sessionid_sign, session.userAgent, session.savedAt, session.cookieExpiresAt,
      ])).digest('hex');
    } catch (error) { readError = error; }
    if (fingerprint === this.lastReadFingerprint && now < this.nextCheck) { this.notices(); return; }
    this.lastReadFingerprint = fingerprint;
    this.nextCheck = now + this.settings.intervalMs;
    try {
      if (readError) throw readError;
      await authenticate('session', process.env, { session, signal: this.controller.signal });
      if (this.closed) return;
      this.canCollect = true;
      this.revision = fingerprint;
      if (this.state.incident && !this.state.incident.recoveredAt) {
        this.state.incident.recoveredAt = new Date().toISOString();
      }
      this.update('healthy', 'TradingView session verified.');
      delete this.state.lastProbeError;
      this.state.cookieExpiresAt = session.cookieExpiresAt || null;
    } catch (error) {
      if (this.closed) return;
      this.nextCheck = now + 30_000;
      if (error.code === 'LOGIN_REQUIRED') {
        this.canCollect = false;
        if (!this.state.incident || this.state.incident.recoveredAt) {
          this.state.incident = { id: randomUUID(), startedAt: new Date().toISOString() };
        }
        this.update('login-required', error.message);
      } else {
        // Keep an already authenticated stream running through a temporary
        // probe failure. Never turn a WAF/429/5xx/timeout into a login alert.
        this.state.lastProbeError = error.message;
        if (this.canCollect || !this.state.incident || this.state.incident.recoveredAt) {
          this.update('unavailable', error.message);
        }
      }
    }
    this.state.lastCheckedAt = new Date().toISOString();
    this.save();
    this.notices();
  }

  update(status, message) {
    if (this.state.status !== status) {
      console.log(`Session health: ${status}. ${message}`);
      this.store.log('session_health', { status, message });
    }
    this.state.status = status;
    this.state.message = message;
  }
}
