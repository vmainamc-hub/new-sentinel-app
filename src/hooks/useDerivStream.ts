import { useEffect, useRef, useState } from "react";
import { derivBus } from "@/lib/deriv/tick-bus";
import type { Tick } from "@/lib/analytics";

export type DerivSymbol = {
  symbol: string;
  name: string;
  group: "Standard" | "1s" | "Crash/Boom" | "Jump";
};

// Only symbols actually offered on Deriv. Names match Deriv's UI labels.
export const DERIV_SYMBOLS: DerivSymbol[] = [
  { symbol: "R_10", name: "Volatility 10 Index", group: "Standard" },
  { symbol: "R_25", name: "Volatility 25 Index", group: "Standard" },
  { symbol: "R_50", name: "Volatility 50 Index", group: "Standard" },
  { symbol: "R_75", name: "Volatility 75 Index", group: "Standard" },
  { symbol: "R_100", name: "Volatility 100 Index", group: "Standard" },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index", group: "1s" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s) Index", group: "1s" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s) Index", group: "1s" },
  { symbol: "1HZ75V", name: "Volatility 75 (1s) Index", group: "1s" },
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index", group: "1s" },
  // Volatility 150 (1s) and 250 (1s) are deliberately excluded from the
  // supported universe — they are outside the operator's traded scope.

  { symbol: "JD10", name: "Jump 10 Index", group: "Jump" },
  { symbol: "JD25", name: "Jump 25 Index", group: "Jump" },
  { symbol: "JD50", name: "Jump 50 Index", group: "Jump" },
  { symbol: "JD75", name: "Jump 75 Index", group: "Jump" },
  { symbol: "JD100", name: "Jump 100 Index", group: "Jump" },
  { symbol: "BOOM300N", name: "Boom 300 Index", group: "Crash/Boom" },
  { symbol: "BOOM500", name: "Boom 500 Index", group: "Crash/Boom" },
  { symbol: "BOOM1000", name: "Boom 1000 Index", group: "Crash/Boom" },
  { symbol: "CRASH300N", name: "Crash 300 Index", group: "Crash/Boom" },
  { symbol: "CRASH500", name: "Crash 500 Index", group: "Crash/Boom" },
  { symbol: "CRASH1000", name: "Crash 1000 Index", group: "Crash/Boom" },
];

export type DerivStatus = "idle" | "connecting" | "live" | "error" | "closed";

export function useDerivStream(symbol: string | null, enabled: boolean) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [status, setStatus] = useState<DerivStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !symbol) {
      setStatus("idle");
      setTicks([]);
      return;
    }
    setError(null);

    const scheduleFlush = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setTicks([...derivBus.getTicks(symbol)]);
      });
    };

    const unsubStatus = derivBus.onStatus((s) => {
      setStatus(
        s === "live"
          ? "live"
          : s === "error"
            ? "error"
            : s === "connecting"
              ? "connecting"
              : "idle",
      );
    });
    const unsubHistory = derivBus.onHistory((sym) => {
      if (sym === symbol) scheduleFlush();
    });
    const unsubTick = derivBus.onTick((sym) => {
      if (sym === symbol) scheduleFlush();
    });
    const unsubSym = derivBus.subscribe([symbol]);
    // Prime immediately if buffer already exists.
    const existing = derivBus.getTicks(symbol);
    if (existing.length) setTicks([...existing]);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      unsubTick();
      unsubHistory();
      unsubStatus();
      unsubSym();
    };
  }, [symbol, enabled]);

  return { ticks, status, error };
}
