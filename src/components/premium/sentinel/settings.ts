// SENTINEL AI (unified): settings. Two parts, stored apart:
//   - the trading settings, which are Sixfold's own (stake, recovery, loss shield, Meter floors...), and
//   - the engine settings below: how much the Sentinel + Fusion engines must agree, and the quality gates.
import type { Contract } from '../sixfold/bot';
import {
    DEFAULT_SETTINGS as SIXFOLD_DEFAULTS,
    normalizeSettings as normalizeTrading,
    type SixfoldSettings,
} from '../sixfold/money';

/** careful: both engines must back the contract. balanced: Sentinel leads, Fusion agreeing eases the bar and standing down vetoes. active: Fusion may lead and the scanner may trade alone, at a higher bar. */
export type EngineMode = 'careful' | 'balanced' | 'active';
export const ENGINE_MODES: readonly EngineMode[] = ['careful', 'balanced', 'active'];

/** The six propositions both engines speak. */
export const PROPOSITION_KEYS = ['OVER:1', 'OVER:2', 'OVER:3', 'UNDER:8', 'UNDER:7', 'UNDER:6'] as const;

export type EngineSettings = {
    mode: EngineMode;
    /** Propositions that may be traded, e.g. 'OVER:2'. */
    propositions: string[];
    /** Sentinel quality gates. 0 = off. */
    minScore: number;
    maxDanger: number;
    requireMomentum: boolean;
    skipBlocked: boolean;
};

export const DEFAULT_ENGINE: EngineSettings = {
    mode: 'balanced',
    propositions: [...PROPOSITION_KEYS],
    minScore: 0,
    maxDanger: 0,
    requireMomentum: true,
    skipBlocked: true,
};

const int = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

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
        minScore: int(s.minScore, d.minScore, 0, 100),
        maxDanger: int(s.maxDanger, d.maxDanger, 0, 100),
        requireMomentum: typeof s.requireMomentum === 'boolean' ? s.requireMomentum : d.requireMomentum,
        skipBlocked: typeof s.skipBlocked === 'boolean' ? s.skipBlocked : d.skipBlocked,
    };
};

/** Sixfold's trading defaults, tuned for this tool: the engine's own entry digit is used (SMART learns one when the engine has none). */
export const DEFAULT_TRADING: SixfoldSettings = normalizeTrading({
    ...SIXFOLD_DEFAULTS,
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
        blurb: 'Both engines must back a contract, Sentinel at least building. Fewer trades, strict Meter floors.',
        engine: { mode: 'careful', requireMomentum: true, skipBlocked: true, minScore: 55, maxDanger: 60 },
        trading: {
            selectivity: 'strict',
            meterFloor: 55,
            meterFloorRecovery: 58,
            lossShield: true,
            pickyAfterLoss: true,
        },
    },
    {
        id: 'balanced',
        name: 'Balanced',
        blurb: 'Sentinel leads. Fusion agreeing eases the bar and Fusion standing down vetoes.',
        engine: { mode: 'balanced', requireMomentum: true, skipBlocked: true, minScore: 0, maxDanger: 0 },
        trading: {
            selectivity: 'balanced',
            meterFloor: 50,
            meterFloorRecovery: 52,
            lossShield: true,
            pickyAfterLoss: true,
        },
    },
    {
        id: 'active',
        name: 'Active',
        blurb: 'Fusion may lead and the scanner may trade alone, at a higher bar. More trades, more variance.',
        engine: { mode: 'active', requireMomentum: false, skipBlocked: true, minScore: 0, maxDanger: 0 },
        trading: {
            selectivity: 'active',
            meterFloor: 45,
            meterFloorRecovery: 48,
            lossShield: true,
            pickyAfterLoss: true,
        },
    },
];

const TRADING_KEY = 'sentinelai.auto.settings.v1';
const ENGINE_KEY = 'sentinelai.auto.engine.v1';

export const loadTrading = (): SixfoldSettings => {
    try {
        const raw = window.localStorage.getItem(TRADING_KEY);
        return normalizeTradingSettings(raw ? JSON.parse(raw) : null);
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
