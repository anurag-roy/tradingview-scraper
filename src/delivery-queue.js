/** Pace individual first attempts; never retry a job. Unstarted jobs remain
 * 'queued' in the monitor's durable state and can resume after a restart. */
export class DeliveryQueue {
  constructor(onError) {
    this.onError = onError;
    this.jobs = [];
    this.ids = new Set();
    this.active = null;
    this.timer = null;
    this.closed = false;
    this.nextAt = 0;
  }

  enqueue(id, run) {
    if (this.closed || this.ids.has(id)) return;
    this.ids.add(id);
    this.jobs.push({ id, run });
    this.drain();
  }

  drain() {
    if (this.closed || this.active || this.timer || !this.jobs.length) return;
    const wait = this.nextAt - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.drain(); }, wait);
      return;
    }
    const { id, run } = this.jobs.shift();
    this.active = Promise.resolve().then(run).then(attempted => {
      if (attempted) this.nextAt = Date.now() + 3100;
    }).catch(this.onError).finally(() => {
      this.ids.delete(id);
      this.active = null;
      this.drain();
    });
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.jobs = [];
    this.ids.clear();
  }

  async close() {
    this.closed = true;
    this.clear();
    await this.active;
  }
}
