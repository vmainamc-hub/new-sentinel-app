// SENTINEL AI: settings. Two parts, stored apart:
//   - the trading settings, which are Sixfold's own (stake, recovery, loss shield, Meter floors...), and
//   - the engine settings below: which Pulse signal strength may trade, and which of the six contracts.
import type { Contract } from '../sixfold/bot';
import {
    DEFAULT_SETTINGS as SIXFOLD_DEFAULTS,
    normalizeSettings as normalizeTrading,
    type SixfoldSettings,
} from '../sixfold/money';

/** careful: only strong Pulse signals. balanced: strong and steady. active: also watch signals, and the scanner may trade alone at a higher bar. */
export type EngineMode = 'careful' | 'balanced' | 'active';
export const ENGINE_MODES: readonly EngineMode[] = ['careful', 'balanced', 'active'];

/** The six contracts Pulse reads. */
export const PROPOSITION_KEYS = ['OVER:1', 'OVER:2', 'OVER:3', 'UNDER:8', 'UNDER:7', 'UNDER:6'] as const;

export type EngineSettings = {
    mode: EngineMode;
    /** Propositions that may be traded, e.g. 'OVER:2'. */
    propositions: string[];
};

export const DEFAULT_ENGINE: EngineSettings = {
    mode: 'balanced',
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
        propositions: props,
    };
};

/** Sixfold's trading defaults, tuned for this tool: SMART entry learns each market's entry digits from its own recent ticks. */
// Pulse already reads recent winning rates in four windows and steps a signal down after a run of losses, so the hardest Sixfold filters are eased here: the
// win-streak guard (which waits for six winning digits in a row, rare enough to stop almost every trade) is off, the pressure
// gate is a little wider and the Meter floors a little lower. None of this changes the odds of a contract; it only decides how
// often the machine trades. The Careful preset keeps the stricter pressure gate and Meter floors.
export const SENTINEL_GATES: Partial<SixfoldSettings> = {
    winStreakGate: false,
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
export const normalizeTradingSettings = (raw: Partial<SixfoldSettings> | null | undefined): SixfoldSettings =>
    normalizeTrading({ ...DEFAULT_TRADING, ...(raw ?? {}) });

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
export const PRESETS: Preset[] = [
    {
        id: 'careful',
        name: 'Careful',
        blurb: 'Only strong Pulse signals (all four windows agree). Fewest trades, strict Meter floors.',
        engine: { mode: 'careful' },
        trading: {
            selectivity: 'strict',
            winStreakGate: false,
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
            winStreakGate: false,
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
            winStreakGate: false,
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

export const loadTrading = (): SixfoldSettings => {
    try {
        const raw = window.localStorage.getItem(TRADING_KEY);
        const stored = raw ? JSON.parse(raw) : null;
        // One time only: settings saved before the gate changes above take the new gate values; later choices are respected.
        if (stored && !window.localStorage.getItem(GATES_MIGRATION_KEY)) {
            window.localStorage.setItem(GATES_MIGRATION_KEY, '1');
            const migrated = normalizeTradingSettings({ ...stored, ...SENTINEL_GATES });
            saveTrading(migrated);
            return migrated;
        }
        window.localStorage.setItem(GATES_MIGRATION_KEY, '1');
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
