// APEX SENTINEL — ENGINE HEALTH.
// No engine may silently fail. Every layer reports its own state and the
// terminal surfaces it.
export type EngineState = "ONLINE" | "DEGRADED" | "INSUFFICIENT DATA" | "ERROR" | "DISABLED";

export interface EngineHealth {
  name: string;
  state: EngineState;
  detail: string;
  updatedAt: number;
}

class HealthRegistry {
  private map = new Map<string, EngineHealth>();
  private listeners = new Set<() => void>();

  set(name: string, state: EngineState, detail: string) {
    const prev = this.map.get(name);
    if (prev && prev.state === state && prev.detail === detail) return;
    this.map.set(name, { name, state, detail, updatedAt: Date.now() });
    this.listeners.forEach((l) => l());
  }

  /** Run a synchronous engine and record ERROR instead of crashing the core. */
  guard<T>(
    name: string,
    fn: () => T,
    onOk: (v: T) => { state: EngineState; detail: string },
  ): T | null {
    try {
      const v = fn();
      const s = onOk(v);
      this.set(name, s.state, s.detail);
      return v;
    } catch (err) {
      this.set(name, "ERROR", err instanceof Error ? err.message.slice(0, 120) : "Unknown failure");
      return null;
    }
  }

  all(): EngineHealth[] {
    return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const engineHealth = new HealthRegistry();

export const ENGINE_NAMES = [
  "Digit statistics",
  "Digit intelligence",
  "Losing-digit threat",
  "Critical digit protection",
  "Green/red bar engine",
  "Transition chain",
  "Statistical tests",
  "ML baseline (logistic)",
  "Tree ensemble",
  "Sequence model",
  "Deep sequence model",
  "Historical analogue",
  "Forward projection",
  "Backtest / walk-forward",
  "AI analyst",
  "Skeptic",
  "Chief intelligence",
] as const;

// Layers that only run on demand start in a known, honest state.
engineHealth.set("Deep sequence model", "DISABLED", "Baselines not yet beaten out-of-sample.");
engineHealth.set("AI analyst", "DISABLED", "Runs on SCAN NOW or explicit request (cost control).");
engineHealth.set("Skeptic", "DISABLED", "Runs with the analyst chain.");
engineHealth.set("Chief intelligence", "DISABLED", "Runs with the analyst chain.");
engineHealth.set("Backtest / walk-forward", "DISABLED", "Run from the Validation tab.");
