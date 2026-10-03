import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AUTH_DIRECTORY } from './auth.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export class LoginController extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.state = { status: 'idle', desktopReady: false, message: 'Start a browser session to sign in to TradingView.' };
  }

  update(status, message, desktopReady = false) {
    this.state = { ...this.state, status, message, desktopReady };
    this.emit('change');
    console.log(`Remote login: ${status}. ${message}`);
  }

  async start(fresh) {
    if (this.starting || this.child) throw new Error('A login session is already open.');
    this.starting = true;
    try {
      if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Remote Chrome login requires Linux and a non-root user.');
      try { await fs.access(path.join(AUTH_DIRECTORY, 'vnc.passwd')); }
      catch { throw new Error('Create .auth/vnc.passwd with x11vnc -storepasswd first. See SETUP.md.'); }
      try { await fs.access('/usr/share/novnc/vnc.html'); }
      catch { throw new Error('Install the Ubuntu noVNC package first. See SETUP.md.'); }
      if (this.closing) throw new Error('The login service is shutting down.');
      this.state.startedAt = new Date().toISOString();
      delete this.state.finishedAt;
      this.cancelled = false;
      this.update('starting', 'Opening Chrome. This can take a few seconds.');
      const child = spawn('/bin/bash', [path.join(root, 'scripts/vps-login.sh'), ...(fresh ? ['--fresh'] : [])], {
        cwd: root, detached: true,
        env: { ...process.env, TV_LOGIN_NODE: process.execPath,
          LOGIN_DESKTOP_PORT: String(this.settings.desktopPort), LOGIN_VNC_PORT: String(this.settings.vncPort),
          LOGIN_TIMEOUT_SECONDS: String(this.settings.timeout) },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.child = child;
      let output = '';
      child.stdout.on('data', chunk => {
        output = (output + chunk.toString()).slice(-4096);
        if (output.includes('TV_LOGIN_DESKTOP_READY') && this.state.status === 'starting') {
          this.update('open', 'Connect below, enter the VNC password, and complete TradingView sign-in.', true);
        }
      });
      child.on('error', () => this.update('failed', 'Could not start the login process. Check the login service logs.'));
      child.once('close', code => {
        clearTimeout(this.forceStop);
        clearTimeout(this.deadline);
        this.child = null;
        this.state.finishedAt = new Date().toISOString();
        this.update(this.cancelled ? 'cancelled' : code === 0 ? 'saved' : 'failed',
          this.cancelled ? 'Login session closed.' : code === 0
            ? 'Login saved. The monitor will detect it automatically.'
            : 'Login did not finish. Try again or check .auth/remote-login.log on the VPS.');
      });
      // Covers startup as well as the browser's own login timeout.
      this.deadline = setTimeout(() => { void this.stop(); }, (this.settings.timeout + 90) * 1000);
    } finally { this.starting = false; }
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.cancelled = true;
    this.update('stopping', 'Closing Chrome and the remote screen.');
    const exited = new Promise(resolve => child.once('close', resolve));
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } };
    kill('SIGTERM');
    clearTimeout(this.forceStop);
    this.forceStop = setTimeout(() => kill('SIGKILL'), 10_000);
    await exited;
  }
}
