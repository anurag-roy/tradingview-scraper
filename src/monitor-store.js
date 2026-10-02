import fs from 'node:fs';
import path from 'node:path';

export class MonitorStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(directory, 'monitor.lock');
    try {
      this.lockFd = fs.openSync(this.lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never steal a lock automatically: even an apparently dead PID can be
      // reused. The operator can remove a stale lock after checking the PID.
      throw new Error(`Monitor lock exists at ${this.lock}. Stop the other monitor, or remove a stale lock after checking its PID.`);
    }
    fs.writeFileSync(this.lockFd, `${process.pid}\n`);
    this.file = path.join(directory, 'state.json');
    try {
      this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
      if (this.data && (this.data.version !== 1 || !this.data.streams || !this.data.records)) {
        throw new Error('Unsupported monitor state');
      }
    } catch {
      this.close();
      throw new Error('Monitor state is unreadable; refusing to risk duplicate alerts. Inspect state.json before restarting.');
    }
  }

  useDay(day) {
    if (this.data?.day === day) return;
    this.data = { version: 1, day, streams: {}, records: {} };
    this.save();
    fs.writeFileSync(path.join(this.directory, 'events.jsonl'), '', { mode: 0o600 });
    fs.rmSync(path.join(this.directory, 'candles.json'), { force: true });
  }

  writeJson(name, value) {
    const destination = path.join(this.directory, name);
    const temporary = `${destination}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    const directoryFd = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }

  save() { this.writeJson('state.json', this.data); }

  log(type, details = {}) {
    fs.appendFileSync(path.join(this.directory, 'events.jsonl'),
      `${JSON.stringify({ type, receivedAt: new Date().toISOString(), ...details })}\n`, { mode: 0o600 });
  }

  close() {
    if (this.lockFd !== undefined) {
      fs.closeSync(this.lockFd);
      fs.rmSync(this.lock, { force: true });
      this.lockFd = undefined;
    }
  }
}
