import { api_base } from "@/external/bot-skeleton";
export type BusStatus = "idle" | "connecting" | "live" | "error";
export type Tick = { t: number; price: number };
type TickListener = (symbol: string, tick: Tick) => void;
type HistoryListener = (symbol: string, ticks: Tick[]) => void;
type StatusListener = (s: BusStatus) => void;

const MAX_BUFFER = 1000;
/** How often the per-market watchdog checks that every subscribed market is still delivering ticks. */
const WATCHDOG_MS = 4000;
/**
 * A subscribed market that delivered nothing for this long has lost its stream. Volatility and Jump indices tick every
 * 1-2 seconds, so this is several missed ticks, and it is still shorter than the engine's own 15 s STALE limit.
 */
const SILENT_MS = 10000;
/** Minimum gap between two revive attempts of the SAME market (multiplied while it keeps failing, capped at 5x). */
const REVIVE_COOLDOWN_MS = 8000;
/** Revives are spread out so 15 dead streams are not re-requested in a single burst. */
const REVIVE_STAGGER_MS = 150;
const FORGET_TIMEOUT_MS = 2500;
const ALREADY_SUBSCRIBED = /already ?subscribed/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class DerivTickBus {
  private buffers = new Map<string, Tick[]>();
  private digits = new Map<string, number[]>();
  private pip = new Map<string, number>();
  private refs = new Map<string, number>();
  private tickLs = new Set<TickListener>();
  private histLs = new Set<HistoryListener>();
  private statusLs = new Set<StatusListener>();
  private subs = new Map<string, any>();
  private status: BusStatus = "idle";
  private lastEpoch = new Map<string, number>();
  private seedTries = new Map<string, number>();
  private messageUnsub: { unsubscribe: () => void } | null = null;

  // Per-market health. `lastSeenAt` is wall-clock time of the last message that market delivered.
  private lastSeenAt = new Map<string, number>();
  private reviveAt = new Map<string, number>();
  private reviveTries = new Map<string, number>();
  private failed = new Set<string>();
  private seeding = new Set<string>();
  private retrying = new Set<string>();
  private inflight = 0;
  private boundApi: unknown = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  getStatus() {
    return this.status;
  }
  getTicks(s: string) {
    return (this.buffers.get(s) || []).slice(-MAX_BUFFER);
  }
  getDigits(s: string) {
    return (this.digits.get(s) || []).slice(-MAX_BUFFER);
  }
  getPipSize(s: string) {
    return this.pip.get(s) ?? 2;
  }
  /** Milliseconds since this market last delivered anything (Infinity if it never has). */
  getAgeMs(s: string) {
    const at = this.lastSeenAt.get(s);
    return at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at;
  }
  /** Number of last digits currently buffered for a market (cheap: no copy). */
  getDigitCount(s: string) {
    return this.digits.get(s)?.length ?? 0;
  }
  /**
   * How many of the `window` ticks that end `skip` ticks before the newest one have a last digit in `wanted`.
   * skip = 0 is the latest `window` ticks, skip = window is the `window` ticks before that (equal-sized samples).
   * Returns NaN when the market does not have `skip + window` ticks yet, so callers can never mistake "no data" for "zero".
   */
  countDigits(s: string, window: number, skip: number, wanted: ArrayLike<number>) {
    const d = this.digits.get(s);
    const w = Math.trunc(Number(window));
    const k = Math.trunc(Number(skip));
    if (!d || !Number.isFinite(w) || !Number.isFinite(k) || w < 1 || k < 0 || d.length < w + k) return NaN;
    const set = new Set<number>();
    for (let i = 0; i < wanted.length; i += 1) set.add(Number(wanted[i]));
    let n = 0;
    for (let i = d.length - k - w; i < d.length - k; i += 1) if (set.has(d[i])) n += 1;
    return n;
  }
  onTick(cb: TickListener) {
    this.tickLs.add(cb);
    return () => {
      this.tickLs.delete(cb);
    };
  }
  onHistory(cb: HistoryListener) {
    this.histLs.add(cb);
    for (const [s, t] of this.buffers) cb(s, [...t]);
    return () => {
      this.histLs.delete(cb);
    };
  }
  onStatus(cb: StatusListener) {
    this.statusLs.add(cb);
    cb(this.status);
    return () => {
      this.statusLs.delete(cb);
    };
  }

  private setStatus(s: BusStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusLs.forEach((f) => f(s));
  }

  /**
   * One market failing must not paint the whole bus as broken, and a recovered bus must go back to "live".
   * The engine only raises its FEED STALE / ANALYSIS LAG alarms while the bus is "live", so a status that stayed
   * on "connecting" after a re-sync switched its self-healing off for good.
   */
  private settle() {
    if (!this.refs.size) return;
    const bad = this.failed.size;
    if (bad > 0 && bad * 2 >= this.refs.size) this.setStatus("error");
    else if (this.inflight === 0) this.setStatus("live");
  }

  /** Deriv reports pip size as a number of decimals (2) but some payloads use the pip value (0.01): accept both. */
  private static decimals(p: unknown) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n > 0 && n < 1) return Math.max(0, Math.round(-Math.log10(n)));
    return Math.trunc(n);
  }
  /**
   * Last digits depend on how many decimals the market quotes (Volatility 10/25 use 3, Volatility 50/75 use 4, the rest 2).
   * History used to be digitised with a default of 2 before the first live tick revealed the real value, which gave wrong
   * digits for those markets. Whenever the pip size becomes known or changes, the buffered digits are recomputed.
   */
  private applyPip(s: string, p: unknown) {
    const decimals = DerivTickBus.decimals(p);
    if (decimals === null || this.pip.get(s) === decimals) return;
    this.pip.set(s, decimals);
    const buf = this.buffers.get(s);
    if (buf) {
      this.digits.set(
        s,
        buf.map((v) => this.digit(s, v.price)),
      );
    }
  }

  private digit(s: string, p: number) {
    const f = Math.pow(10, this.getPipSize(s));
    return Math.abs(Math.round(p * f)) % 10;
  }
  private setBuffer(s: string, t: Tick[]) {
    const x = t.slice(-MAX_BUFFER);
    this.buffers.set(s, x);
    this.digits.set(
      s,
      x.map((v) => this.digit(s, v.price)),
    );
    this.lastEpoch.set(s, x.length ? Math.floor(x[x.length - 1].t / 1000) : 0);
  }
  private append(s: string, t: Tick) {
    const b = this.buffers.get(s) || [];
    b.push(t);
    if (b.length > MAX_BUFFER) b.splice(0, b.length - MAX_BUFFER);
    this.buffers.set(s, b);
    const d = this.digits.get(s) || [];
    d.push(this.digit(s, t.price));
    if (d.length > MAX_BUFFER) d.splice(0, d.length - MAX_BUFFER);
    this.digits.set(s, d);
    this.lastEpoch.set(s, Math.floor(t.t / 1000));
  }

  subscribe(symbols: string[]) {
    const unique = [...new Set(symbols)];
    for (const s of unique) {
      this.refs.set(s, (this.refs.get(s) || 0) + 1);
      if ((this.refs.get(s) || 0) === 1) {
        this.lastSeenAt.set(s, Date.now()); // grace period: a new market is not "silent" yet
        void this.seed(s);
      }
    }
    this.setStatus("live");
    this.startWatchdog();
    return () => {
      for (const s of unique) {
        const n = (this.refs.get(s) || 1) - 1;
        if (n <= 0) {
          this.refs.delete(s);
          const sub = this.subs.get(s);
          try {
            sub?.unsubscribe?.();
          } catch {
            /* already closed */
          }
          this.subs.delete(s);
          this.lastSeenAt.delete(s);
          this.reviveAt.delete(s);
          this.reviveTries.delete(s);
          this.failed.delete(s);
        } else this.refs.set(s, n);
      }
      if (!this.refs.size) this.stopWatchdog();
    };
  }

  /** A failed seed used to leave the market dead for good. Retry with back-off for as long as someone still subscribes to it. */
  private retrySeed(s: string) {
    if (this.retrying.has(s)) return;
    const n = (this.seedTries.get(s) || 0) + 1;
    this.seedTries.set(s, n);
    this.retrying.add(s);
    setTimeout(
      () => {
        this.retrying.delete(s);
        if (this.refs.has(s)) void this.seed(s);
      },
      Math.min(30000, 1500 * n * n),
    );
  }

  /**
   * Re-establishes every live tick subscription on the CURRENT socket: forgets the old stream ids, then re-seeds.
   * Use when the feed went quiet (dropped subscription / reconnect) but nothing errored.
   */
  async resync() {
    const api: any = api_base.api;
    if (!api) return;
    try {
      this.messageUnsub?.unsubscribe();
    } catch {
      /* already closed */
    }
    this.messageUnsub = null;
    this.failed.clear();
    for (const s of [...this.refs.keys()]) {
      const id = this.subs.get(s)?.id;
      this.subs.delete(s);
      this.seedTries.delete(s);
      this.lastSeenAt.set(s, Date.now());
      if (id) {
        try {
          await api.send({ forget: id });
        } catch {
          /* the stream may already be gone */
        }
      }
      void this.seed(s);
    }
  }

  /** Opens the live tick stream of one market. "Already subscribed" means another part of the app owns it: its ticks still reach us. */
  private async openStream(s: string) {
    const api: any = api_base.api;
    try {
      const sub: any = api.send({ ticks: s, subscribe: 1 });
      this.subs.set(s, sub);
      if (sub?.then) {
        const resolved = await sub;
        this.subs.set(s, resolved?.subscription || resolved);
      }
    } catch (e: any) {
      // Another part of the app (e.g. the Bulk Trader feed) already owns this market's stream. Its ticks still reach
      // onMessage below, so this is fine: just never forget a stream we do not own.
      if (ALREADY_SUBSCRIBED.test(String(e?.message || "") + JSON.stringify(e ?? ""))) this.subs.delete(s);
      else throw e;
    }
  }

  private async seed(s: string) {
    if (!api_base.api) {
      if (this.refs.has(s)) this.failed.add(s);
      this.settle();
      this.retrySeed(s);
      return;
    }
    this.seeding.add(s);
    this.inflight += 1;
    this.setStatus("connecting");
    try {
      const r: any = await api_base.api.send({
        ticks_history: s,
        adjust_start_time: 1,
        count: MAX_BUFFER,
        end: "latest",
        style: "ticks",
      });
      if (r?.history?.prices) {
        this.applyPip(s, r.pip_size ?? (api_base as any).pip_sizes?.[s]);
        const times = r.history.times || [];
        this.setBuffer(
          s,
          r.history.prices.map((p: number, i: number) => ({ t: Number(times[i]) * 1000, price: Number(p) })),
        );
        this.histLs.forEach((f) => f(s, this.getTicks(s)));
      }
      await this.openStream(s);
      this.attachMessageListener();
      this.seedTries.delete(s);
      this.failed.delete(s);
      this.lastSeenAt.set(s, Date.now());
    } catch {
      if (this.refs.has(s)) this.failed.add(s);
      this.retrySeed(s);
    } finally {
      this.seeding.delete(s);
      this.inflight -= 1;
      this.settle();
    }
  }

  private attachMessageListener() {
    if (this.messageUnsub || !api_base.api) return;
    this.boundApi = api_base.api;
    this.messageUnsub = api_base.api.onMessage().subscribe((msg: any) => {
      const m = msg?.data || msg;
      if (m?.msg_type !== "tick" || !m.tick) return;
      const s = String(m.tick.symbol || "");
      if (!this.refs.has(s)) return;
      // Any tick message proves the stream is alive, even a duplicate one that is dropped below.
      this.lastSeenAt.set(s, Date.now());
      this.reviveTries.delete(s);
      const epoch = Number(m.tick.epoch),
        price = Number(m.tick.quote);
      if (!s || !Number.isFinite(epoch) || !Number.isFinite(price)) return;
      if (epoch <= (this.lastEpoch.get(s) || 0)) return;
      if (m.tick.pip_size !== undefined) this.applyPip(s, m.tick.pip_size);
      const t = { t: epoch * 1000, price };
      this.append(s, t);
      this.tickLs.forEach((f) => f(s, t));
    });
  }

  // ── per-market watchdog ─────────────────────────────────────────────────────────────────────────
  // Deriv streams die silently: DBot forgets ALL tick streams on the shared socket whenever a bot stops or its market
  // changes (ticks_service.forgetAll), and a replaced / half-open socket delivers nothing without any error. The watchdog
  // notices a market that went quiet and re-opens just that market's stream, without refetching its history.

  private onWake = () => {
    if (typeof document !== "undefined" && document.hidden) return;
    this.checkFeed();
  };

  private startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkFeed(), WATCHDOG_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onWake);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onWake);
      window.addEventListener("focus", this.onWake);
    }
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onWake);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onWake);
      window.removeEventListener("focus", this.onWake);
    }
  }

  /** Markets that are subscribed, not already being (re)seeded, and have been quiet for longer than SILENT_MS. */
  private silentMarkets(now: number) {
    return [...this.refs.keys()].filter((s) => {
      if (this.failed.has(s) || this.seeding.has(s) || this.retrying.has(s)) return false;
      if (now - (this.lastSeenAt.get(s) ?? 0) <= SILENT_MS) return false;
      const wait = REVIVE_COOLDOWN_MS * Math.min(5, 1 + (this.reviveTries.get(s) ?? 0));
      return now - (this.reviveAt.get(s) ?? 0) > wait;
    });
  }

  /** Runs the watchdog once. Also exposed so callers can ask for an immediate check (tab visible again, socket reconnected). */
  checkFeed() {
    const api: any = api_base.api;
    if (!api || !this.refs.size) return;
    // The socket instance was replaced (reconnect): our message listener is bound to the dead one.
    if (this.boundApi && this.boundApi !== api) {
      this.boundApi = api;
      void this.resync();
      return;
    }
    if (!this.messageUnsub) this.attachMessageListener();
    const now = Date.now();
    this.silentMarkets(now).forEach((s, i) => {
      this.reviveAt.set(s, now);
      this.reviveTries.set(s, (this.reviveTries.get(s) ?? 0) + 1);
      setTimeout(() => {
        void this.revive(s).catch(() => {
          if (!this.refs.has(s)) return;
          this.failed.add(s);
          this.settle();
          this.retrySeed(s);
        });
      }, i * REVIVE_STAGGER_MS);
    });
  }

  /** Forgets one market's stale stream id and subscribes to its ticks again. Never waits on a dead socket. */
  private async revive(s: string) {
    const api: any = api_base.api;
    if (!api || !this.refs.has(s)) return;
    const id = this.subs.get(s)?.id;
    this.subs.delete(s);
    if (id) {
      try {
        await Promise.race([Promise.resolve(api.send({ forget: id })).catch(() => undefined), sleep(FORGET_TIMEOUT_MS)]);
      } catch {
        /* the stream may already be gone */
      }
    }
    if (!this.refs.has(s)) return;
    await this.openStream(s);
    this.attachMessageListener();
    this.lastSeenAt.set(s, Date.now());
  }

  getDiagnostics() {
    let n = 0;
    for (const b of this.buffers.values()) n += b.length;
    const now = Date.now();
    return {
      status: this.status,
      subscribedSymbols: this.refs.size,
      bufferedSymbols: this.buffers.size,
      bufferedTicks: n,
      lastTickAt: Math.max(...[0, ...this.lastEpoch.values()].map((x) => x * 1000)),
      silentSymbols: [...this.refs.keys()].filter((s) => now - (this.lastSeenAt.get(s) ?? 0) > SILENT_MS),
    };
  }
}
export const derivBus = new DerivTickBus();
