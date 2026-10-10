// APEX SENTINEL — Continuous Data Core.
// Subscribes ONCE to the existing shared Deriv tick bus (no second connection
// architecture), maintains per-market intelligence, and recomputes on a
// throttled batched schedule so ~20 markets stay analysed without blocking
// the UI thread.
import { derivBus, type BusStatus } from "@/sentinel-engine/lib/deriv/tick-bus";
import { APEX_UNIVERSE, isApexSymbol } from "./universe";
import {
  anomalyEngine,
  digitPressure,
  digitStatistics,
  entropyEngine,
  hiddenBuildup,
  marketQuality,
  personalityEngine,
  regimeEngine,
  sequencePattern,
  transitions,
  trendEngine,
  volatilityEngine,
  WINDOW_BASE,
  tail,
} from "./engines";
import { CONTRACT_SPECS, evaluateContract, winnersFor } from "./contracts";
import { fingerprint, lookupAnalogue, observeAnalogue, observeCalibration } from "./memory";
import { digitIntelligence } from "./digit-intel";
import { barEngine } from "./bars";
import { psychologyEngine, psychologyKey } from "./psychology";
import { specialDigitRisk } from "./special-digits";
import { losingDigitExposure } from "./exposure";
import { fluctuationTracker } from "./fluctuation";
import { marketProfiles, scoreBandOf } from "./profiles";
import { criticalDigits } from "./critical";
import { buildBattle } from "./battle";
import { runEnsemble, type EnsembleResult } from "./ml";
import { loadRefinement } from "./settings";
import { engineHealth } from "./health";
import { apexSimulator, engineAgreement, simulatorAdjustment } from "./simulator";
import { entryLab } from "./entry-conditions";
import { observationEngine } from "@/sentinel-engine/lib/sentinel/observation";
import { mapIntelToObservationInputs } from "@/sentinel-engine/lib/sentinel/observation/engineAdapter";
import {
  APEX_CONTRACTS,
  type ApexContractId,
  type ContractEval,
  type DataState,
  type MarketIntel,
} from "./types";

// The universe is owned by ./universe.ts — the single validated source of
// truth. Volatility 150 (1s) / 250 (1s) can never re-enter through here.
export { APEX_UNIVERSE } from "./universe";

const RECOMPUTE_MS = 700;
const BATCH = 6; // markets recomputed per cycle — spreads CPU across frames
const MIN_TICKS = 200;
const STALE_MS = 15_000;
/** Deep digit horizon required by the multi-window digit engines. */
const DEEP_BUFFER = 5000;
/** Ticks between walk-forward retrains — training is expensive, so it is throttled. */
const RETRAIN_EVERY = 150;

interface Pending {
  key: string;
  confidence: number;
  winners: Set<number>;
  tickIndex: number;
}

interface EnsembleCache {
  atTicks: number;
  result: EnsembleResult;
}

class ApexCore {
  private intel = new Map<string, MarketIntel>();
  private edgeHistory = new Map<string, number[]>(); // `${sym}:${contract}` -> composite edges
  private pending = new Map<string, Pending>(); // outcome resolution for memory/calibration
  private lastTickAt = new Map<string, number>();
  private tickCount = new Map<string, number>();
  /** Digit history beyond the shared bus cap, needed by the 5000-tick windows. */
  private deepDigits = new Map<string, number[]>();
  private deepPrices = new Map<string, number[]>();
  private ensembleCache = new Map<string, EnsembleCache>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubBus: (() => void)[] = [];
  private cursor = 0;
  private refs = 0;
  private status: BusStatus = "idle";
  private version = 0;
  private inFlight = false;
  private pendingCycle = false;
  /** Rolling average cost of one cycle (ms) — drives adaptive back-off. */
  private avgCycleMs = 0;
  private analyseFailures = new Map<string, number>();


  /** Deep digit history for a market (up to 5000 ticks). */
  getDeepDigits(symbol: string): number[] {
    return this.deepDigits.get(symbol) ?? [];
  }

  getStatus() {
    return this.status;
  }

  getVersion() {
    return this.version;
  }

  getRefCount(): number {
    return this.refs;
  }

  isActive(): boolean {
    return this.refs > 0 && this.timer !== null;
  }

  getAll(): MarketIntel[] {
    return APEX_UNIVERSE.map((s) => this.intel.get(s.symbol)).filter((x): x is MarketIntel =>
      Boolean(x),
    );
  }

  get(symbol: string): MarketIntel | undefined {
    return this.intel.get(symbol);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    const release = this.retain();
    return () => {
      this.listeners.delete(fn);
      release();
    };
  }

  /**
   * Route-scoped lifecycle retention. Increments the reference count.
   * Starts background processing when references transition from 0 to 1.
   * Returns a cleanup release function.
   */
  retain(): () => void {
    this.refs++;
    if (this.refs === 1) {
      this.start();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /**
   * Releases a reference to the core. Decrements reference count safely.
   * When references reach 0, completely halts all continuous background timers,
   * in-flight cycles, and bus subscriptions.
   */
  release(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) {
      this.stop();
    }
  }

  private start() {
    const symbols = APEX_UNIVERSE.map((s) => s.symbol).filter(isApexSymbol);
    // Every valid market owns a live simulator state from the moment Sentinel
    // starts — not from the moment it becomes the top candidate.
    apexSimulator.restore();
    apexSimulator.registerUniverse(APEX_UNIVERSE.map((s) => ({ symbol: s.symbol, name: s.name })));
    this.unsubBus.push(derivBus.subscribe(symbols));
    this.unsubBus.push(
      derivBus.onStatus((s) => {
        this.status = s;
        this.emit();
      }),
    );
    this.unsubBus.push(
      derivBus.onTick((sym, tick) => {
        if (!isApexSymbol(sym)) return;
        this.lastTickAt.set(sym, tick.t);
        this.tickCount.set(sym, (this.tickCount.get(sym) ?? 0) + 1);
        this.appendDeep(sym, tick.price);
        this.resolvePending(sym);
        // Contract-resolution simulator: only ticks that arrive AFTER an entry
        // may resolve it, which is what keeps the paper record causal.
        const d = derivBus.getDigits(sym);
        if (d.length) {
          apexSimulator.onTick(sym, d[d.length - 1], tick.t);
          // Entry-condition discovery resolves its own shadow entries on the
          // same causal rule: only later ticks may settle an earlier entry.
          entryLab.onTick(sym, d[d.length - 1], tick.t);
        }
      }),
    );
    this.unsubBus.push(
      derivBus.onHistory((sym, ticks) => {
        if (!ticks.length) return;
        this.lastTickAt.set(sym, ticks[ticks.length - 1].t);
        // Seed the deep buffer once from whatever history the bus delivered.
        if (!this.deepDigits.has(sym)) {
          this.deepPrices.set(
            sym,
            ticks.map((t) => t.price),
          );
          this.deepDigits.set(sym, derivBus.getDigits(sym).slice());
        }
      }),
    );

    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  /** Self-scheduling loop — never overlaps, and backs off when cycles are slow. */
  private schedule(delay: number) {
    if (this.refs <= 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.cycle();
    }, delay);
  }

  private stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubBus.forEach((u) => u());
    this.unsubBus = [];
    this.inFlight = false;
    this.pendingCycle = false;
  }


  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** Resolve the previous prediction for a market against the digit just seen. */
  private resolvePending(sym: string) {
    const digits = derivBus.getDigits(sym);
    if (!digits.length) return;
    const d = digits[digits.length - 1];
    for (const id of APEX_CONTRACTS) {
      const k = `${sym}:${id}`;
      const p = this.pending.get(k);
      if (!p) continue;
      this.pending.delete(k);
      const won = p.winners.has(d);
      observeAnalogue(p.key, won);
      observeCalibration(sym, p.confidence, won);
    }
  }

  /** Yield the main thread so input, paint and other tabs stay responsive. */
  private yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => {
      const ric = (globalThis as any).requestIdleCallback as
        | ((cb: () => void, opts?: { timeout: number }) => number)
        | undefined;
      if (ric) ric(() => resolve(), { timeout: 120 });
      else setTimeout(resolve, 0);
    });
  }

  private async cycle() {
    if (this.refs <= 0) return;
    // IN-FLIGHT COALESCING: If an expensive cycle is still executing, do NOT launch
    // another full computation concurrently. Mark that a fresh cycle was requested.
    if (this.inFlight) {
      this.pendingCycle = true;
      return;
    }
    this.inFlight = true;
    this.pendingCycle = false;
    const started = Date.now();

    try {
      const slice: string[] = [];
      for (let i = 0; i < BATCH; i++) {
        const s = APEX_UNIVERSE[(this.cursor + i) % APEX_UNIVERSE.length];
        slice.push(s.symbol);
      }
      this.cursor = (this.cursor + BATCH) % APEX_UNIVERSE.length;
      for (const sym of slice) {
        if (this.refs <= 0) break;
        try {
          this.analyse(sym);
        } catch (err) {
          // One market throwing used to abort the whole slice (and skip its emit), so the remaining markets in
          // it went stale for good. Contain it and carry on.
          const n = (this.analyseFailures.get(sym) ?? 0) + 1;
          this.analyseFailures.set(sym, n);
          if (n === 1 || n % 50 === 0) console.warn(`[apex] analyse(${sym}) failed (${n}x):`, err);
        }
        // One market per task: keeps every chunk of work short instead of
        // blocking the main thread for the whole batch.
        await this.yieldToBrowser();
      }

      if (this.refs > 0) {
        // Continuous observation layer tick update to advance state machines and expire execution windows
        try {
          observationEngine.tick(Date.now());
          const health = observationEngine.getHealthStatus();
          engineHealth.set(
            "Observation Engine",
            health.status === "HEALTHY"
              ? "ONLINE"
              : health.status === "DEGRADED"
                ? "DEGRADED"
                : "ERROR",
            health.message,
          );
        } catch (err) {
          observationEngine.recordIngestError(err);
          engineHealth.set("Observation Engine", "ERROR", String(err));
        }

        this.emit();
      }
    } finally {
      this.inFlight = false;
      const elapsed = Date.now() - started;
      this.avgCycleMs = this.avgCycleMs ? this.avgCycleMs * 0.7 + elapsed * 0.3 : elapsed;
      // Adaptive back-off: never spend more than ~50% of wall-clock time computing.
      const delay = Math.min(5000, Math.max(RECOMPUTE_MS, Math.round(this.avgCycleMs)));
      if (this.refs > 0) this.schedule(this.pendingCycle ? 0 : delay);
      this.pendingCycle = false;
    }
  }


  /** Append a live tick into the extended 5000-tick buffers. */
  private appendDeep(sym: string, price: number) {
    const digits = this.deepDigits.get(sym) ?? derivBus.getDigits(sym).slice(0, -1);
    const prices = this.deepPrices.get(sym) ?? [];
    const d = derivBus.getDigits(sym);
    const last = d.length ? d[d.length - 1] : null;
    if (last !== null) {
      digits.push(last);
      if (digits.length > DEEP_BUFFER) digits.splice(0, digits.length - DEEP_BUFFER);
      this.deepDigits.set(sym, digits);
    }
    prices.push(price);
    if (prices.length > DEEP_BUFFER) prices.splice(0, prices.length - DEEP_BUFFER);
    this.deepPrices.set(sym, prices);
  }

  reset(): void {
    this.stop();
    this.refs = 0;
    this.intel.clear();
    this.lastTickAt.clear();
    this.tickCount.clear();
    this.deepDigits.clear();
    this.deepPrices.clear();
    this.ensembleCache.clear();
    this.pending.clear();
    this.cursor = 0;
    this.version = 0;
  }

  analyse(symbol: string) {
    if (!isApexSymbol(symbol)) return;
    const meta = APEX_UNIVERSE.find((s) => s.symbol === symbol);
    if (!meta) return;
    const settings = loadRefinement();
    const ticks = derivBus.getTicks(symbol);
    const busDigits = derivBus.getDigits(symbol);
    // Prefer the extended buffer; fall back to the bus when it is still filling.
    const deep = this.deepDigits.get(symbol) ?? [];
    const digits = deep.length >= busDigits.length ? deep : busDigits;
    const deepPrices = this.deepPrices.get(symbol) ?? [];
    const lastTickAt =
      this.lastTickAt.get(symbol) ?? (ticks.length ? ticks[ticks.length - 1].t : 0);
    const ageMs = lastTickAt ? Date.now() - lastTickAt : Number.POSITIVE_INFINITY;

    let dataState: DataState = "OK";
    if (!digits.length) dataState = "UNAVAILABLE";
    else if (digits.length < MIN_TICKS) dataState = "THIN";
    else if (ageMs > STALE_MS) dataState = "STALE";

    if (dataState === "UNAVAILABLE") {
      this.intel.set(symbol, {
        symbol,
        name: meta.name,
        dataState,
        ticks: 0,
        lastTickAt: 0,
        ageMs: Number.POSITIVE_INFINITY,
        stats: null,
        pressure: null,
        transition: null,
        sequence: null,
        entropy: null,
        anomaly: null,
        volatility: null,
        trend: null,
        regime: null,
        personality: null,
        buildup: null,
        quality: null,
        danger: 100,
        contracts: [],
        best: null,
        updatedAt: Date.now(),
        digitIntel: null,
        bars: null,
        criticalReport: null,
        battle: null,
        deepTicks: 0,
        psychology: null,
        specialDigits: null,
        fluctuation: null,
      });
      return;
    }

    const prices = tail(ticks, WINDOW_BASE).map((t) => t.price);
    const stats = digitStatistics(digits);
    const pressure = digitPressure(stats);
    const transition = transitions(digits);
    const entropy = entropyEngine(stats);
    const sequence = sequencePattern(digits, winnersFor(CONTRACT_SPECS.UNDER7));
    const anomaly = anomalyEngine(stats, entropy, sequence);
    const volatility = volatilityEngine(prices);
    const trend = trendEngine(prices);
    const regime = regimeEngine(entropy, volatility, trend, pressure);
    const personality = personalityEngine(digits);
    const buildup = hiddenBuildup(stats, pressure);
    const quality = marketQuality(stats, entropy, volatility, anomaly);

    // ── Refinement engines ────────────────────────────────────────────
    const digitIntel = digitIntelligence(digits, transition.nextDist);
    engineHealth.set(
      "Digit intelligence",
      digits.length >= 1000
        ? "ONLINE"
        : digits.length >= MIN_TICKS
          ? "DEGRADED"
          : "INSUFFICIENT DATA",
      `${digits.length} ticks buffered (target ${DEEP_BUFFER}).`,
    );
    const bars = barEngine(deepPrices.length >= prices.length ? deepPrices : prices, digits);
    engineHealth.set(
      "Green/red bar engine",
      bars.n > 50 ? "ONLINE" : "INSUFFICIENT DATA",
      `${bars.n} bars observed.`,
    );
    const criticalReport = criticalDigits(digitIntel, bars);
    engineHealth.set(
      "Critical digit protection",
      criticalReport.digits.length ? "ONLINE" : "DEGRADED",
      `${criticalReport.digits.length} critical structures mapped.`,
    );

    // Entropy drift feeds the forward projection's concentration outlook.
    const entropyDelta =
      entropy.entropy - (this.intel.get(symbol)?.entropy?.entropy ?? entropy.entropy);

    const prevIntel = this.intel.get(symbol);
    const contracts: ContractEval[] = [];

    for (const id of APEX_CONTRACTS) {
      const spec = CONTRACT_SPECS[id];
      const histKey = `${symbol}:${id}`;
      const history = this.edgeHistory.get(histKey) ?? [];
      const prev = prevIntel?.contracts.find((c) => c.id === id);

      // Historical analogue for the CURRENT state, looked up from the state the
      // terminal recorded on the previous cycle.
      const analogue = prevIntel && prev ? lookupAnalogue(fingerprint(prevIntel, prev)) : null;

      const ensemble = this.ensembleFor(symbol, id, digits, winnersFor(spec), analogue, settings);

      const evaluation = evaluateContract(spec, {
        digits,
        stats,
        pressure,
        transition,
        sequence: sequencePattern(digits, winnersFor(spec)),
        entropy,
        anomaly,
        volatility,
        trend,
        regime,
        quality,
        prev,
        edgeHistory: history,
        dataAgeMs: ageMs,
        intel: digitIntel,
        bars,
        criticalReport,
        ensemble,
        analogue,
        entropyDelta,
        settings,
      });
      history.push(evaluation.compositeEdge);
      if (history.length > 60) history.splice(0, history.length - 60);
      this.edgeHistory.set(histKey, history);
      contracts.push(evaluation);
    }

    // ── DIGIT PSYCHOLOGY (observed Over / Under configurations) ───────
    const psychology = psychologyEngine(stats, pressure, bars, digitIntel);
    engineHealth.set(
      "Digit psychology",
      digits.length >= 400 ? "ONLINE" : "INSUFFICIENT DATA",
      psychology.summary,
    );

    // ── SPECIAL DIGIT RISK (0/1/8/9), market level ────────────────────
    const profile = marketProfiles.get(symbol);
    const adverse: Record<number, number> = {};
    if (profile) {
      for (const [d, c] of Object.entries(profile.dangerousDigits)) adverse[Number(d)] = c;
    }
    const specialDigits = specialDigitRisk(digitIntel, bars, [], adverse);

    // ── LOSING-DIGIT EXPOSURE per contract, and its danger effect ─────
    for (const c of contracts) {
      const exposure = losingDigitExposure(digits, c.winners, digitIntel, bars, c.label);
      const special = specialDigitRisk(digitIntel, bars, exposure.losers, adverse);
      c.exposure = exposure;
      c.specialRisk = special;

      // A favourable aggregate percentage never overrides a dangerous losing
      // digit: exposure and special-digit risk raise contract danger directly.
      c.danger = Math.round(
        Math.max(
          c.danger,
          Math.min(100, exposure.losingDigitExposure * 0.75 + special.exposureRisk * 0.35),
        ),
      );
      c.alerts = [...c.alerts, ...exposure.alerts, ...special.alerts];
      if (exposure.state === "SEVERE" || special.state === "HOSTILE") {
        c.quality = Math.max(0, c.quality - 12);
        c.opportunity = Math.max(0, c.opportunity - 10);
      }
    }

    contracts.sort((a, b) => b.opportunity - a.opportunity);
    const best = contracts[0] ?? null;

    // ── FLUCTUATION (is the evidence holding still?) ──────────────────
    fluctuationTracker.observe(symbol, {
      leader: best ? best.id : "NONE",
      edge: best ? Math.round(best.compositeEdge * 10) / 10 : 0,
      confidence: best ? Math.round(best.confidence) : 0,
      psychologyAligned: psychology.over.aligned || psychology.under.aligned,
      rank: contracts.findIndex((c) => c.id === best?.id),
    });
    const fluctuation = fluctuationTracker.report(symbol);
    if (fluctuation.state === "UNSTABLE" || fluctuation.state === "CHAOTIC") {
      for (const c of contracts) {
        c.quality = Math.max(0, c.quality - Math.round(fluctuation.score * 0.12));
        c.danger = Math.min(100, c.danger + Math.round(fluctuation.score * 0.2));
      }
    }

    const battle = buildBattle(
      symbol,
      contracts,
      digitIntel.increasing.slice(0, 3),
      digitIntel.decreasing.slice(0, 3),
      bars.current ? `${bars.consecutive}× ${bars.current.color}` : "n/a",
    );

    const intel: MarketIntel = {
      symbol,
      name: meta.name,
      dataState,
      ticks: digits.length,
      lastTickAt,
      ageMs,
      stats,
      pressure,
      transition,
      sequence,
      entropy,
      anomaly,
      volatility,
      trend,
      regime,
      personality,
      buildup,
      quality,
      danger: Math.round(
        Math.max(
          0,
          Math.min(
            100,
            anomaly.score * 0.3 +
              (volatility.ratio > 1 ? (volatility.ratio - 1) * 50 : 0) +
              (best?.threat ? best.threat.groupThreat * 0.2 : 0) +
              (best?.exposure ? best.exposure.losingDigitExposure * 0.25 : 0) +
              specialDigits.marketRisk * 0.12 +
              fluctuation.score * 0.18 +
              (dataState === "STALE" ? 40 : 0),
          ),
        ),
      ),
      contracts,
      best,
      updatedAt: Date.now(),
      digitIntel,
      bars,
      criticalReport,
      battle,
      deepTicks: digits.length,
      psychology,
      specialDigits,
      fluctuation,
    };

    // ── ONE AUTHORITATIVE DANGER VALUE (PHASE 15B) ────────────────────
    // ApexCore previously composed a SECOND, weaker danger object here
    // (intel-only inputs: no momentum, no competition, no RED semantics, no
    // pressure windows), which the observation adapter then preferred over
    // its own richer composition. That produced two competing danger values
    // for the same cell.
    //
    // The authoritative composition now lives in ONE place — the observation
    // adapter — and ApexCore reads it back. The adapter snapshot is memoised
    // per market/tick identity, so the later ingestion below is a cache hit
    // and the engines still run exactly once per market per cycle.
    try {
      const authoritative = mapIntelToObservationInputs(intel, digits);
      const byProposition = new Map(authoritative.map((o) => [String(o.proposition), o]));
      for (const c of contracts) {
        const composition = byProposition.get(String(c.id))?.danger?.raw;
        if (composition) c.dangerComposition = composition;
      }
    } catch (err) {
      observationEngine.recordIngestError(err);
    }


    this.intel.set(symbol, intel);

    // Offer the frozen state to the chronological contract simulator. It may
    // open at most one locked paper position per market and resolves it only
    // on the actual expiry digit.
    apexSimulator.consider(intel, engineAgreement);

    // ── MARKET-SPECIFIC LEARNING (causal) ─────────────────────────────
    // Capture the state that existed at ENTRY time BEFORE any outcome is
    // known, then ingest resolutions. Learning can never look ahead.
    const simState = apexSimulator.getState(symbol);
    const openTrade = simState?.openTrade ?? null;
    if (openTrade) {
      const c = contracts.find((x) => x.id === openTrade.contract) ?? best;
      marketProfiles.captureEntry(openTrade.id, {
        symbol,
        name: meta.name,
        contract: openTrade.contract,
        contractLabel: openTrade.contractLabel,
        entryCondition: openTrade.entryCondition,
        regime: regime.label,
        psychology: psychologyKey(psychology),
        scoreBand: scoreBandOf(c?.opportunity ?? 0),
        engines: (c?.supports ?? []).map((e) => e.engine),
        at: openTrade.openedAt,
      });
    }
    marketProfiles.sync();

    // Independent entry-condition discovery: every rule is shadow-tested on
    // this market's own contracts, partitioned strictly by symbol.
    entryLab.consider(intel, digits);

    // Continuous 90-cell Observation Layer ingestion
    try {
      const obsInputs = mapIntelToObservationInputs(intel, digits);
      for (const input of obsInputs) {
        observationEngine.ingest(input);
      }
    } catch (err) {
      observationEngine.recordIngestError(err);
    }

    // Register a fresh prediction per contract so the next tick teaches
    // market memory + calibration a real, observed outcome.
    if (dataState === "OK") {
      for (const c of contracts) {
        this.pending.set(`${symbol}:${c.id}`, {
          key: fingerprint(intel, c),
          confidence: c.confidence,
          winners: new Set(c.winners),
          tickIndex: digits.length,
        });
      }
    }
  }

  /**
   * Walk-forward training is expensive, so each contract retrains only every
   * RETRAIN_EVERY ticks. Between retrains the last validated ensemble is
   * reused — never a stale claim of validation, because the fold statistics
   * travel with the result.
   */
  private ensembleFor(
    symbol: string,
    id: ApexContractId,
    digits: number[],
    winners: number[],
    analogue: { n: number; rate: number } | null,
    settings: ReturnType<typeof loadRefinement>,
  ): EnsembleResult | null {
    const key = `${symbol}:${id}`;
    const cached = this.ensembleCache.get(key);
    if (cached && digits.length - cached.atTicks < RETRAIN_EVERY) return cached.result;
    if (digits.length < 210 + settings.wfTrain + settings.wfTest) {
      engineHealth.set(
        "ML baseline (logistic)",
        "INSUFFICIENT DATA",
        `Needs ${210 + settings.wfTrain + settings.wfTest} ticks; deepest market has ${digits.length}.`,
      );
      return cached?.result ?? null;
    }

    const winSet = new Set(winners);
    let w = 0;
    for (const d of digits) if (winSet.has(d)) w++;
    const theoretical = winners.length / 10;

    const result = engineHealth.guard(
      "ML baseline (logistic)",
      () =>
        runEnsemble({
          digits,
          winners,
          theoretical,
          wfTrain: settings.wfTrain,
          wfTest: settings.wfTest,
          wfStep: settings.wfStep,
          analogue,
          rule:
            (w + theoretical * settings.shrinkageStrength) /
            (digits.length + settings.shrinkageStrength),
          ruleN: digits.length,
        }),
      (r) => ({
        state: r.validated ? ("ONLINE" as const) : ("DEGRADED" as const),
        detail: r.validated
          ? `${r.validated} model(s) validated out-of-sample.`
          : "MODEL NOT VALIDATED — no model beats its base rate out-of-sample.",
      }),
    );
    if (!result) return cached?.result ?? null;

    engineHealth.set(
      "Tree ensemble",
      result.models.find((m) => m.id === "TREE")?.status === "VALIDATED" ? "ONLINE" : "DEGRADED",
      result.models.find((m) => m.id === "TREE")?.note ?? "",
    );
    engineHealth.set(
      "Sequence model",
      result.models.find((m) => m.id === "SEQUENCE")?.status === "VALIDATED"
        ? "ONLINE"
        : "DEGRADED",
      result.models.find((m) => m.id === "SEQUENCE")?.note ?? "",
    );

    this.ensembleCache.set(key, { atTicks: digits.length, result });
    return result;
  }
}

export const apexCore = new ApexCore();
export type { ApexContractId };
