// SENTINEL AI: settings. Two parts, stored apart:
//   - the trading settings, which are Sixfold's own (stake, recovery, loss shield, Meter floors...), and
//   - the engine settings below: which Pulse signal strength may trade, and which of the six contracts.
import type { Contract } from '../sixfold/bot';
import { MARKETS } from '../sixfold/feed';
import {
    DEFAULT_SETTINGS as SIXFOLD_DEFAULTS,
    normalizeSettings as normalizeTrading,
    type SixfoldSettings,
} from '../sixfold/money';

/** hunter: the signal source is a voice, never a gate, and the bar eases while nothing trades. careful: only strong Pulse signals. balanced: strong and steady. active: also watch signals, and the scanner may trade alone at a higher bar. */
export type EngineMode = 'hunter' | 'careful' | 'balanced' | 'active';
export const ENGINE_MODES: readonly EngineMode[] = ['hunter', 'careful', 'balanced', 'active'];

/** Where the signals come from: Pulse (windows above the fair rate) or Digits Analysis (the market ranking). */
export type SignalSource = 'pulse' | 'digits';
export const SIGNAL_SOURCES: readonly SignalSource[] = ['pulse', 'digits'];

/** The six contracts Pulse reads. */
export const PROPOSITION_KEYS = ['OVER:1', 'OVER:2', 'OVER:3', 'UNDER:8', 'UNDER:7', 'UNDER:6'] as const;

export type EngineSettings = {
    mode: EngineMode;
    source: SignalSource;
    /** Propositions that may be traded, e.g. 'OVER:2'. */
    propositions: string[];
};

export const DEFAULT_ENGINE: EngineSettings = {
    mode: 'balanced',
    source: 'pulse',
    propositions: [...PROPOSITION_KEYS],
};

/** Accepts anything (including settings saved by the old Sentinel / Fusion version) and returns a complete object. */
export const normalizeEngine = (raw: unknown): EngineSettings => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const d = DEFAULT_ENGINE;
    const props = Array.isArray(s.propositions)
        ? Array.from(new Set(s.propositions.map(String))).filter(p =>
              (PROPOSITION_KEYS as readonly string[]).includes(p)
          )
        : [...d.propositions];
    return {
        mode: ENGINE_MODES.includes(s.mode as EngineMode) ? (s.mode as EngineMode) : d.mode,
        source: SIGNAL_SOURCES.includes(s.source as SignalSource) ? (s.source as SignalSource) : d.source,
        propositions: props,
    };
};

/** Sixfold's trading defaults, tuned for this tool: SMART entry learns each market's entry digits from its own recent ticks. */
// The win-streak guard is MANDATORY here: Sentinel buys only while the market's latest digits are a run of winning ("green") digits
// for the contract it is about to buy, never in a red run. The run needed is 3 by default (Sixfold's own default of 6 stops almost
// every trade). Pulse and Digits Analysis already decide where to look; the pressure gate and Meter floors are a little wider
// than Sixfold's. None of this changes the odds of a contract; it only decides when it buys.
export const GREENS_DEFAULT = 3;
export const SENTINEL_GATES: Partial<SixfoldSettings> = {
    winStreakGate: true,
    winStreak: GREENS_DEFAULT,
    pressureMax: 45,
    meterFloor: 45,
    meterFloorRecovery: 48,
};
export const DEFAULT_TRADING: SixfoldSettings = normalizeTrading({
    ...SIXFOLD_DEFAULTS,
    ...SENTINEL_GATES,
    entry: 'SMART',
    selectivity: 'balanced',
});
/** Whatever was saved, the win-streak guard is always on: Sentinel never buys inside a run of red digits. */
export const normalizeTradingSettings = (raw: Partial<SixfoldSettings> | null | undefined): SixfoldSettings =>
    normalizeTrading({ ...DEFAULT_TRADING, ...(raw ?? {}), winStreakGate: true });

export const contractsFor = (engine: Pick<EngineSettings, 'propositions'>): Contract[] =>
    engine.propositions.map(p => {
        const [side, param] = p.split(':');
        return { side: side as 'OVER' | 'UNDER', param: Number(param) };
    });

export type Preset = {
    id: string;
    name: string;
    blurb: string;
    engine: Partial<EngineSettings>;
    trading: Partial<SixfoldSettings>;
};
/**
 * The Hunter's trading rules: watch every market, take an Over 2 or Under 7 as soon as one is the best of the board, and after a
 * loss look across the whole board again and fire Over 3 or Under 6. The filters that waited for rare moments are off (pressure,
 * windows, Meter floors, paper-first opening); the win-streak guard stays on (two winning digits in a row is enough here), the Meter
 * guide still refuses a contract sitting in a loss cluster, and the loss shield, stop loss and loss limits stay.
 */
export const HUNTER_TRADING: Partial<SixfoldSettings> = {
    useOver: true,
    primaryOver: 2,
    useUnder: true,
    primaryUnder: 7,
    recovery: true,
    recoveryOver: 3,
    recoveryUnder: 6,
    selectivity: 'active',
    entry: 'SMART',
    winStreakGate: true,
    winStreak: 2,
    pressureGate: false,
    multiWindowGate: false,
    winPressureGate: false,
    virtualHook: false,
    vhOpening: false,
    meterFloor: 0,
    meterFloorRecovery: 0,
    pickyAfterLoss: false,
    lossShield: true,
    restTrades: 1,
    stopLoss: 10,
    maxConsecutiveLosses: 4,
    takeProfit: 1,
    markets: MARKETS.map(m => m[0]),
};
export const PRESETS: Preset[] = [
    {
        id: 'hunter',
        name: 'Hunter',
        blurb: 'Watches every market and always has a best candidate. Over 2 / Under 7, then Over 3 / Under 6 after a loss. The signal source eases the bar but never blocks, and the bar also eases while nothing trades.',
        engine: { mode: 'hunter', propositions: ['OVER:2', 'UNDER:7'] },
        trading: HUNTER_TRADING,
    },
    {
        id: 'careful',
        name: 'Careful',
        blurb: 'Only strong Pulse signals (all four windows agree). Fewest trades, strict Meter floors.',
        engine: { mode: 'careful' },
        trading: {
            selectivity: 'strict',
            winStreakGate: true,
            winStreak: 4,
            pressureMax: 35,
            meterFloor: 55,
            meterFloorRecovery: 58,
            lossShield: true,
            pickyAfterLoss: true,
        },
    },
    {
        id: 'balanced',
        name: 'Balanced',
        blurb: 'Strong and steady Pulse signals. A good rate of signals with a sensible bar.',
        engine: { mode: 'balanced' },
        trading: {
            selectivity: 'balanced',
            winStreakGate: true,
            winStreak: 3,
            pressureMax: 45,
            meterFloor: 45,
            meterFloorRecovery: 48,
            lossShield: true,
            pickyAfterLoss: true,
        },
    },
    {
        id: 'active',
        name: 'Active',
        blurb: 'Also watch signals, and the scanner may trade alone at a higher bar. Most trades, most variance.',
        engine: { mode: 'active' },
        trading: {
            selectivity: 'active',
            winStreakGate: true,
            winStreak: 2,
            pressureMax: 55,
            meterFloor: 40,
            meterFloorRecovery: 44,
            lossShield: true,
            pickyAfterLoss: true,
        },
    },
];

const TRADING_KEY = 'sentinelai.auto.settings.v1';
const ENGINE_KEY = 'sentinelai.auto.engine.v1';

const GATES_MIGRATION_KEY = 'sentinelai.auto.gates.v1';
const GREENS_MIGRATION_KEY = 'sentinelai.auto.greens.v1';

export const loadTrading = (): SixfoldSettings => {
    try {
        const raw = window.localStorage.getItem(TRADING_KEY);
        const stored = raw ? JSON.parse(raw) : null;
        const gatesDone = Boolean(window.localStorage.getItem(GATES_MIGRATION_KEY));
        const greensDone = Boolean(window.localStorage.getItem(GREENS_MIGRATION_KEY));
        window.localStorage.setItem(GATES_MIGRATION_KEY, '1');
        window.localStorage.setItem(GREENS_MIGRATION_KEY, '1');
        // One time each: settings saved before a gate change take the new values; later choices are respected.
        // Settings saved before the green-digits rule had the guard off with a run of 6: they move to the new rule (3 greens).
        if (stored && (!gatesDone || !greensDone)) {
            const migrated = normalizeTradingSettings({
                ...stored,
                ...(gatesDone ? {} : SENTINEL_GATES),
                ...(greensDone ? {} : { winStreakGate: true, winStreak: GREENS_DEFAULT }),
            });
            saveTrading(migrated);
            return migrated;
        }
        return normalizeTradingSettings(stored);
    } catch {
        return DEFAULT_TRADING;
    }
};
export const saveTrading = (s: SixfoldSettings) => {
    try {
        window.localStorage.setItem(TRADING_KEY, JSON.stringify(s));
    } catch {
        /* not remembered */
    }
};
export const loadEngine = (): EngineSettings => {
    try {
        const raw = window.localStorage.getItem(ENGINE_KEY);
        return normalizeEngine(raw ? JSON.parse(raw) : null);
    } catch {
        return { ...DEFAULT_ENGINE, propositions: [...DEFAULT_ENGINE.propositions] };
    }
};
export const saveEngine = (s: EngineSettings) => {
    try {
        window.localStorage.setItem(ENGINE_KEY, JSON.stringify(s));
    } catch {
        /* not remembered */
    }
};
