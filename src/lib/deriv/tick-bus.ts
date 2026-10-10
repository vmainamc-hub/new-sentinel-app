// Shared Deriv WebSocket multiplexer.
// One WebSocket connection is opened for the entire app. Every hook that
// needs live ticks subscribes through this bus, so we get:
//   * ONE connection instead of 6-8 concurrent ones
//   * ONE tick history request per symbol instead of duplicated requests
//   * A single shared in-memory tick buffer per symbol
//   * Automatic reconnection with exponential backoff & multi-endpoint failover
//   * High-performance batch-trimmed buffers preventing main-thread freeze
//   * Consistent status reporting across hooks
//
// This bus uses Deriv's live `ticks` subscription (anonymous, allowed for
// public volatility indices). A short poll fallback kicks in only if we go
// silent for too long (dead-socket detector).
import type { Tick } from "@/lib/analytics";
import { DERIV_WS_URL } from "@/lib/deriv-ws";

export const DERIV_FALLBACK_ENDPOINTS = [
  "wss://ws.derivws.com/websockets/v3?app_id=1089",
  DERIV_WS_URL,
  "wss://ws.binaryws.com/websockets/v3?app_id=1089",
];

const MAX_BUFFER = 1000;
const BUFFER_OVERHEAD = 64; // Batch trim margin: trims once every 64 ticks instead of O(N) shift per tick
const HISTORY_COUNT = 1000; // canonical standard window — one request fills it exactly
const STALE_TICK_MS = 3_500; // if no tick for a subscribed symbol in this time, force a catch-up poll
const CATCHUP_COUNT = 20;
const HANDSHAKE_TIMEOUT_MS = 6_000; // auto-switch endpoint if handshake takes longer than 6s
const PING_INTERVAL_MS = 12_000;
const DEAD_SOCKET_TIMEOUT_MS = 18_000;
/** A history/catch-up request that gets no response within this window is expired. */
const HISTORY_TIMEOUT_MS = 8_000;

export type BusStatus = "idle" | "connecting" | "live" | "error";
type TickListener = (symbol: string, tick: Tick) => void;
type HistoryListener = (symbol: string, ticks: Tick[]) => void;
type StatusListener = (s: BusStatus) => void;

// Fast lookup for powers of 10 to avoid Math.pow on every single streaming tick
const POW10_CACHE = [1, 10, 100, 1000, 10000, 100000, 1000000];
function getPow10(pip: number): number {
  return (pip >= 0 && pip < POW10_CACHE.length) ? POW10_CACHE[pip] : Math.pow(10, pip);
}

class DerivTickBus {
  private ws: WebSocket | null = null;
  private status: BusStatus = "idle";
  private refcount = new Map<string, number>();
  private buffers = new Map<string, Tick[]>();
  // Incremental last-digit buffer, kept in lockstep with `buffers`.
  private digitBuffers = new Map<string, number[]>();
  private subIds = new Map<string, string>(); // symbol -> live subscription id
  private lastEpoch = new Map<string, number>(); // symbol -> last tick epoch (seconds)
  private lastMessageAt = 0;
  private lastPingSentAt = 0;
  private tickListeners = new Set<TickListener>();
  private historyListeners = new Set<HistoryListener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private endpointIndex = 0;

  // ── Reliability state ───────────────────────────────────────────────
  /** Monotonic socket generation; messages/handlers from replaced sockets are rejected. */
  private generation = 0;
  private reqSeq = 1;
  /** req_id -> pending history request metadata. */
  private pendingHistory = new Map<
    number,
    { symbol: string; kind: "seed" | "catchup"; sentAt: number; generation: number }
  >();
  /** symbol -> req_id of the in-flight history request (max one per symbol). */
  private inflightBySymbol = new Map<string, number>();
  /** symbol -> earliest timestamp at which another catch-up may be sent. */
  private catchupCooldown = new Map<string, number>();
  private catchupFailures = new Map<string, number>();
  private reconnectCount = 0;
  private lastTickAt = 0;
  private lastHistoryAt = 0;

  private envHooked = false;

  private wakeLock: any = null;

  getStatus(): BusStatus {
    return this.status;
  }

  getTicks(sym: string): Tick[] {
    const buf = this.buffers.get(sym);
    if (!buf) return [];
    if (buf.length > MAX_BUFFER) {
      return buf.slice(buf.length - MAX_BUFFER);
    }
    return buf;
  }

  /** Rolling last-digit array for a symbol, aligned 1:1 with getTicks(). */
  getDigits(sym: string): number[] {
    const d = this.digitBuffers.get(sym);
    if (!d) return [];
    if (d.length > MAX_BUFFER) {
      return d.slice(d.length - MAX_BUFFER);
    }
    return d;
  }

  // Deriv quotes have different decimal precision per symbol (pip size).
  private pipSize = new Map<string, number>();

  private digitOf(sym: string, price: number): number {
    const pip = this.pipSize.get(sym) ?? 2;
    const factor = getPow10(pip);
    return Math.abs(Math.round(price * factor)) % 10;
  }

  /** Record pip size; rebuild the digit buffer when the precision changes. */
  private setPip(sym: string, pip: number) {
    if (!Number.isFinite(pip) || this.pipSize.get(sym) === pip) return;
    this.pipSize.set(sym, pip);
    const buf = this.buffers.get(sym);
    if (buf && buf.length) this.setBuffer(sym, buf);
  }

  getPipSize(sym: string): number {
    return this.pipSize.get(sym) ?? 2;
  }

  public setBuffer(sym: string, ticks: Tick[]) {
    const trimmed = ticks.length > MAX_BUFFER ? ticks.slice(ticks.length - MAX_BUFFER) : [...ticks];
    this.buffers.set(sym, trimmed);
    const digits = new Array<number>(trimmed.length);
    for (let i = 0; i < trimmed.length; i++) {
      digits[i] = this.digitOf(sym, trimmed[i].price);
    }
    this.digitBuffers.set(sym, digits);
  }

  private appendTick(sym: string, tick: Tick) {
    let buf = this.buffers.get(sym);
    if (!buf) {
      buf = [];
      this.buffers.set(sym, buf);
    }
    buf.push(tick);
    if (buf.length > MAX_BUFFER + BUFFER_OVERHEAD) {
      buf.splice(0, buf.length - MAX_BUFFER);
    }

    let d = this.digitBuffers.get(sym);
    if (!d) {
      d = [];
      this.digitBuffers.set(sym, d);
    }
    d.push(this.digitOf(sym, tick.price));
    if (d.length > MAX_BUFFER + BUFFER_OVERHEAD) {
      d.splice(0, d.length - MAX_BUFFER);
    }
  }

  onTick(cb: TickListener): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onHistory(cb: HistoryListener): () => void {
    this.historyListeners.add(cb);
    // Replay any histories we already have so late subscribers catch up.
    for (const [sym, ticks] of this.buffers.entries()) {
      cb(sym, ticks.length > MAX_BUFFER ? ticks.slice(ticks.length - MAX_BUFFER) : ticks);
    }
    return () => this.historyListeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  /** Subscribe to a set of symbols. Returns an unsubscribe fn. */
  subscribe(symbols: string[]): () => void {
    const unique = Array.from(new Set(symbols));
    for (const s of unique) {
      const c = (this.refcount.get(s) ?? 0) + 1;
      this.refcount.set(s, c);
      if (c === 1 && this.ws?.readyState === WebSocket.OPEN) {
        this.sendHistoryRequest(s);
        this.sendSubscribeRequest(s);
      }
      const existing = this.buffers.get(s);
      if (existing && existing.length) {
        const payload = existing.length > MAX_BUFFER ? existing.slice(existing.length - MAX_BUFFER) : existing;
        queueMicrotask(() => {
          this.historyListeners.forEach((l) => l(s, payload));
        });
      }
    }
    this.ensureConnection();
    this.hookEnv();

    return () => {
      for (const s of unique) {
        const c = (this.refcount.get(s) ?? 1) - 1;
        if (c <= 0) {
          this.refcount.delete(s);
          this.forgetSymbol(s);
        } else {
          this.refcount.set(s, c);
        }
      }
    };
  }

  private setStatus(s: BusStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private ensureConnection() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.connect();
  }

  private connect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }

    this.setStatus("connecting");
    const activeUrl = DERIV_FALLBACK_ENDPOINTS[this.endpointIndex % DERIV_FALLBACK_ENDPOINTS.length];

    let ws: WebSocket;
    try {
      ws = new WebSocket(activeUrl);
    } catch {
      this.setStatus("error");
      this.endpointIndex++;
      this.scheduleReconnect();
      return;
    }
    // Any socket created earlier is now obsolete: its handlers must not be
    // able to touch buffers, status, subscriptions or reconnect state.
    const gen = ++this.generation;
    this.ws = ws;
    this.pendingHistory.clear();
    this.inflightBySymbol.clear();

    // Handshake Timeout Guard: if connection hangs in CONNECTING state, abort and failover
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (gen !== this.generation) return;
      if (ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {}
        this.endpointIndex++;
        this.scheduleReconnect();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => {
      if (gen !== this.generation) {
        try {
          ws.close();
        } catch {}
        return;
      }
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.setStatus("live");
      this.reconnectDelay = 1000;
      this.subIds.clear();
      this.catchupCooldown.clear();
      this.catchupFailures.clear();
      this.lastMessageAt = Date.now();
      for (const sym of this.refcount.keys()) {
        this.sendHistoryRequest(sym);
        this.sendSubscribeRequest(sym);
      }
      this.startPing();
      this.startWatchdog();
    };

    ws.onmessage = (ev) => {
      if (gen !== this.generation) return; // stale socket — ignore entirely
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {

        return;
      }
      if (msg.pong || msg.msg_type === "ping" || msg.ping) {
        return;
      }

      if (msg.error) {
        // Clear the pending slot so a failed history request cannot wedge a
        // symbol forever; back off before retrying.
        const errId = Number(msg.echo_req?.req_id ?? msg.req_id);
        if (Number.isFinite(errId)) this.clearPending(errId, true);
        return;
      }

      if (msg.msg_type === "tick" && msg.tick) {
        const sym = msg.tick.symbol as string;
        const epoch = Number(msg.tick.epoch);
        const price = Number(msg.tick.quote);
        if (msg.tick.id) this.subIds.set(sym, msg.tick.id);
        if (msg.tick.pip_size !== undefined) this.setPip(sym, Number(msg.tick.pip_size));
        const lastKnown = this.lastEpoch.get(sym) ?? 0;
        if (!Number.isFinite(epoch) || !Number.isFinite(price)) return;
        if (epoch <= lastKnown) return;

        const tk: Tick = { t: epoch * 1000, price };
        this.appendTick(sym, tk);
        this.lastEpoch.set(sym, epoch);
        this.lastTickAt = Date.now();
        this.catchupFailures.delete(sym);

        this.tickListeners.forEach((l) => l(sym, tk));
        return;
      }

      if (msg.msg_type === "history" && msg.history) {
        // Correlation first: req_id is authoritative. echo_req is only a
        // validated fallback for servers that omit the correlation id.
        const reqId = Number(msg.req_id ?? msg.echo_req?.req_id);
        const pending = Number.isFinite(reqId) ? this.pendingHistory.get(reqId) : undefined;
        const echoSym =
          typeof msg.echo_req?.ticks_history === "string"
            ? (msg.echo_req.ticks_history as string)
            : null;
        const sym = pending?.symbol ?? echoSym;
        if (!sym) return;
        if (Number.isFinite(reqId)) this.clearPending(reqId, false);
        else if (echoSym) this.clearSymbolPending(echoSym);
        this.lastHistoryAt = Date.now();
        this.catchupFailures.delete(sym);

        if (msg.pip_size !== undefined) this.setPip(sym, Number(msg.pip_size));
        const { prices, times } = msg.history as { prices: number[]; times: number[] };
        if (!prices?.length || !times?.length) return;
        const isSeed = pending
          ? pending.kind === "seed"
          : (msg.echo_req?.count ?? 0) >= HISTORY_COUNT;
        const prev = this.buffers.get(sym) ?? [];
        const lastKnown = this.lastEpoch.get(sym) ?? 0;
        const fresh: Tick[] = [];

        for (let i = 0; i < prices.length; i++) {
          const epoch = times[i];
          if (epoch > lastKnown) {
            fresh.push({ t: epoch * 1000, price: Number(prices[i]) });
          }
        }

        if (isSeed || prev.length === 0) {
          const seed: Tick[] = new Array(prices.length);
          for (let i = 0; i < prices.length; i++) {
            seed[i] = { t: times[i] * 1000, price: Number(prices[i]) };
          }
          this.setBuffer(sym, seed);
          this.lastEpoch.set(sym, times[times.length - 1]);
          const currentBuf = this.getTicks(sym);
          this.historyListeners.forEach((l) => l(sym, currentBuf));
        } else if (fresh.length) {
          for (const tk of fresh) {
            this.appendTick(sym, tk);
          }
          this.lastEpoch.set(sym, times[times.length - 1]);
          for (const tk of fresh) {
            this.tickListeners.forEach((l) => l(sym, tk));
          }
        }
      }
    };

    ws.onerror = () => {
      if (gen !== this.generation) return;
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.setStatus("error");
    };

    ws.onclose = () => {
      if (gen !== this.generation) return; // a newer socket already owns the bus
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.stopPing();
      this.stopWatchdog();
      this.ws = null;
      this.subIds.clear();
      this.pendingHistory.clear();
      this.inflightBySymbol.clear();

      if (this.refcount.size === 0) {
        this.setStatus("idle");
        return;
      }

      this.setStatus("error");
      this.endpointIndex++; // Try alternate endpoint on failure
      this.scheduleReconnect();
    };
  }

  /** Resolve a pending history request; `failed` applies catch-up backoff. */
  private clearPending(reqId: number, failed: boolean) {
    const pending = this.pendingHistory.get(reqId);
    if (!pending) return;
    this.pendingHistory.delete(reqId);
    if (this.inflightBySymbol.get(pending.symbol) === reqId) {
      this.inflightBySymbol.delete(pending.symbol);
    }
    if (failed) {
      const fails = (this.catchupFailures.get(pending.symbol) ?? 0) + 1;
      this.catchupFailures.set(pending.symbol, fails);
      this.catchupCooldown.set(
        pending.symbol,
        Date.now() + Math.min(30_000, 2_500 * 2 ** Math.min(fails, 4)),
      );
    } else {
      this.catchupFailures.delete(pending.symbol);
      this.catchupCooldown.delete(pending.symbol);
    }
  }

  /** True when a symbol is still inside its catch-up backoff window. */
  private inCooldown(sym: string, now: number): boolean {
    const until = this.catchupCooldown.get(sym);
    return until !== undefined && now < until;
  }

  /** Register an outgoing history request so responses can be correlated. */
  private registerPending(sym: string, kind: "seed" | "catchup"): number | null {
    if (this.inflightBySymbol.has(sym)) return null;
    const reqId = this.reqSeq++;
    this.pendingHistory.set(reqId, {
      symbol: sym,
      kind,
      sentAt: Date.now(),
      generation: this.generation,
    });
    this.inflightBySymbol.set(sym, reqId);
    return reqId;
  }

  private clearSymbolPending(sym: string) {
    const reqId = this.inflightBySymbol.get(sym);
    if (reqId !== undefined) this.clearPending(reqId, false);
  }

  /** Expire history requests that never received a response. */
  private expireStalePending(now: number) {
    for (const [reqId, pending] of this.pendingHistory.entries()) {
      if (now - pending.sentAt > HISTORY_TIMEOUT_MS) {
        this.clearPending(reqId, true);
      }
    }
  }

  /** Observable reliability state for the UI and diagnostics panels. */
  getDiagnostics(): {
    status: BusStatus;
    generation: number;
    reconnects: number;
    subscribedSymbols: number;
    pendingHistory: number;
    lastMessageAt: number;
    lastTickAt: number;
    lastHistoryAt: number;
    bufferedSymbols: number;
    bufferedTicks: number;
  } {
    let bufferedTicks = 0;
    for (const b of this.buffers.values()) bufferedTicks += b.length;
    return {
      status: this.status,
      generation: this.generation,
      reconnects: this.reconnectCount,
      subscribedSymbols: this.refcount.size,
      pendingHistory: this.pendingHistory.size,
      lastMessageAt: this.lastMessageAt,
      lastTickAt: this.lastTickAt,
      lastHistoryAt: this.lastHistoryAt,
      bufferedSymbols: this.buffers.size,
      bufferedTicks,
    };
  }


  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.refcount.size === 0) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(10_000, this.reconnectDelay * 1.5);
    this.reconnectCount++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendHistoryRequest(sym: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.registerPending(sym, "seed");
    if (reqId === null) return;
    try {
      this.ws.send(
        JSON.stringify({
          ticks_history: sym,
          adjust_start_time: 1,
          count: HISTORY_COUNT,
          end: "latest",
          style: "ticks",
          req_id: reqId,
        }),
      );
    } catch {
      this.clearPending(reqId, true);
    }
  }

  private sendSubscribeRequest(sym: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
    } catch {}
  }

  private sendCatchupRequest(sym: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.inCooldown(sym, Date.now())) return;
    const reqId = this.registerPending(sym, "catchup");
    if (reqId === null) return;
    try {
      this.ws.send(
        JSON.stringify({
          ticks_history: sym,
          adjust_start_time: 1,
          count: CATCHUP_COUNT,
          end: "latest",
          style: "ticks",
          req_id: reqId,
        }),
      );
    } catch {
      this.clearPending(reqId, true);
    }
  }

  private sendForget(subId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ forget: subId }));
    } catch {}
  }

  private forgetSymbol(sym: string) {
    const subId = this.subIds.get(sym);
    if (subId) this.sendForget(subId);
    this.subIds.delete(sym);
    this.lastEpoch.delete(sym);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.lastPingSentAt = Date.now();
          this.ws.send(JSON.stringify({ ping: 1 }));
        } catch {}
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startWatchdog() {
    this.stopWatchdog();
    // Every 2.5s, check socket health and stale symbols.
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();

      // Expire history requests that never came back so a lost response
      // cannot wedge a symbol's in-flight slot forever.
      this.expireStalePending(now);

      // Proactive Dead-socket detector:
      // If we are subscribed to symbols and have received no messages for DEAD_SOCKET_TIMEOUT_MS,
      // or if ping was sent > 7s ago with zero response, force reconnect.
      const pingUnanswered = this.lastPingSentAt > 0 && now - this.lastPingSentAt > 7_000 && this.lastMessageAt < this.lastPingSentAt;
      const socketSilent = this.refcount.size > 0 && this.lastMessageAt > 0 && now - this.lastMessageAt > DEAD_SOCKET_TIMEOUT_MS;

      if (this.ws?.readyState === WebSocket.OPEN && (pingUnanswered || socketSilent)) {
        try {
          this.ws.close();
        } catch {}
        return;
      }

      // Check per-symbol lag and trigger catch-up requests
      for (const sym of this.refcount.keys()) {
        if (this.inCooldown(sym, now)) continue;
        if (this.inflightBySymbol.has(sym)) continue;
        const lastEpochMs = (this.lastEpoch.get(sym) ?? 0) * 1000;
        if (lastEpochMs && now - lastEpochMs > STALE_TICK_MS) {
          this.sendCatchupRequest(sym);
        }
      }
    }, 2_500);
  }

  private stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private hookEnv() {
    if (this.envHooked || typeof window === "undefined") return;
    this.envHooked = true;

    const kick = () => {
      if (
        !this.ws ||
        this.ws.readyState === WebSocket.CLOSED ||
        this.ws.readyState === WebSocket.CLOSING
      ) {
        this.reconnectDelay = 100;
        this.ensureConnection();
        return;
      }
      if (this.ws.readyState === WebSocket.OPEN) {
        for (const sym of this.refcount.keys()) {
          this.sendCatchupRequest(sym);
        }
      }
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        kick();
        this.requestWakeLock();
      }
    });
    window.addEventListener("online", kick);
    window.addEventListener("focus", kick);
    this.requestWakeLock();
  }

  private async requestWakeLock() {
    try {
      const nav: any = typeof navigator !== "undefined" ? navigator : null;
      if (!nav?.wakeLock?.request) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (this.wakeLock) return;
      this.wakeLock = await nav.wakeLock.request("screen");
      this.wakeLock.addEventListener?.("release", () => {
        this.wakeLock = null;
      });
    } catch {
      // wake lock is best-effort; ignore denials
    }
  }
}

export const derivBus = new DerivTickBus();
