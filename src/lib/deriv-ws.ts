export const DERIV_APP_ID = "33GTaXHoMp3wQACqZXQL5";
export const DERIV_WS_URL = `wss://api.derivws.com/trading/v1/options/ws/public?app_id=${DERIV_APP_ID}`;

export type Tick = { epoch: number; quote: number };

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

type Listener = (msg: any) => void;

/**
 * Minimal Deriv WebSocket client: single shared socket, auto-reconnect,
 * ping keep-alive. Browser only.
 */
export class DerivSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUser = false;
  status: ConnectionStatus = "closed";

  connect() {
    if (typeof window === "undefined") return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closedByUser = false;
    this.setStatus("connecting");
    const ws = new WebSocket(DERIV_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus("open");
      this.pingTimer = setInterval(() => this.send({ ping: 1 }), 20000);
    };
    ws.onmessage = (e) => {
      let data: any;
      try {
        data = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.listeners.forEach((l) => l(data));
    };
    ws.onerror = () => this.setStatus("error");
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.setStatus("closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.attempts++, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  onStatus(l: (s: ConnectionStatus) => void) {
    this.statusListeners.add(l);
    l(this.status);
    return () => this.statusListeners.delete(l);
  }

  onMessage(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  send(payload: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}

let shared: DerivSocket | null = null;
export function getDerivSocket() {
  if (!shared) shared = new DerivSocket();
  return shared;
}

export const SYMBOLS = [
  { symbol: "R_10", name: "Volatility 10 Index" },
  { symbol: "R_25", name: "Volatility 25 Index" },
  { symbol: "R_50", name: "Volatility 50 Index" },
  { symbol: "R_75", name: "Volatility 75 Index" },
  { symbol: "R_100", name: "Volatility 100 Index" },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index" },
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index" },
  { symbol: "stpRNG", name: "Step Index" },
] as const;
