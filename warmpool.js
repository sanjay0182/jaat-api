// warmpool.js - pehle se khule (garam) pages ka pool. venice.js aur perplexity.js dono use karte hain.
// open() ek handle lautata hai: { page, ... }. take() pool se ek handle deta hai aur turant naya bharna shuru kar deta hai.

export class WarmPool {
  constructor({ size = 3, ttlMs = 150000, open, label = "pool", gapMs = 400, sweepMs = 30000 }) {
    Object.assign(this, { size, ttlMs, openFn: open, label, gapMs, sweepMs });
    this.ready = []; this.inflight = new Set(); this.closed = false; this.timer = null; this.gen = 0; this.started = false;
  }

  // pool poora rakho (background). Ek saath teeno khulne se CPU na atke isliye thoda gap
  fill() {
    if (this.closed) return;
    let slot = 0;
    while (this.ready.length + this.inflight.size < this.size) {
      const delay = slot++ * this.gapMs, gen = this.gen;
      const p = (async () => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        try {
          const h = await this.openFn();
          h.at = Date.now();
          if (this.closed || gen !== this.gen) await this.#kill(h); else this.ready.push(h);
        } catch (e) { console.log(`${this.label}: warm page fail:`, String((e && e.message) || e).slice(0, 140)); }
      })().finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  // chrome pehle se chal raha ho to bhi theek, fill() khud open() ke andar ensure karta hai
  start() {
    if (this.closed) return;
    this.started = true;
    this.fill();
    if (!this.timer) { this.timer = setInterval(() => this.sweep(), this.sweepMs); this.timer.unref?.(); }
  }

  async #kill(h) { try { await h.page.close(); } catch {} }
  #bad(h) { return Date.now() - h.at >= this.ttlMs || h.page.isClosed(); }

  // ek tayyar page do. Pool khali ho aur koi ban raha ho to uska intezaar; kuch nahi to null (caller khud khole)
  async take() {
    for (let i = 0; i < 6 && !this.closed; i++) {
      while (this.ready.length) {
        const h = this.ready.shift();
        if (this.#bad(h)) { this.#kill(h); continue; }
        this.fill();
        return h;
      }
      if (!this.inflight.size) { this.fill(); if (!this.inflight.size) return null; }
      await Promise.race([...this.inflight]);
    }
    return null;
  }

  // pool bharne ki pehli koshish poori hone tak ruko (max maxMs). Runner start par: tayyar hone ke baad hi requests lo
  async settled(maxMs = 20000) {
    const end = Date.now() + maxMs;
    while (Date.now() < end && !this.closed && (!this.started || this.inflight.size > 0)) await new Promise((r) => setTimeout(r, 200));
  }

  // purane (stale) pages hatao, naye banao
  async sweep() {
    if (this.closed) return;
    const old = this.ready.filter((h) => this.#bad(h));
    this.ready = this.ready.filter((h) => !this.#bad(h));
    await Promise.all(old.map((h) => this.#kill(h)));
    this.fill();
  }

  // session reset (login wall / limit) ke baad: sab purane pages band, naye bharo
  async flush() {
    this.gen++;
    const old = this.ready; this.ready = [];
    await Promise.all(old.map((h) => this.#kill(h)));
    this.fill();
  }

  async closeAll() {
    this.closed = true; clearInterval(this.timer); this.timer = null;
    const old = this.ready; this.ready = [];
    await Promise.all(old.map((h) => this.#kill(h)));
  }
}
