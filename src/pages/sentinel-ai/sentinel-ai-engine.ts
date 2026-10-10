// SENTINEL AI — adapter to the real Sentinel Signal Engine (src/lib/**, copied unchanged).
//
// This file only READS the engine. Signal production is never altered: it uses the same
// apexCore → rankOpportunities → selectSurfacedOpportunity chain the Forge used, minus the audible alert.
import { api_base } from '@/external/bot-skeleton';
import { apexCore, APEX_UNIVERSE } from '@/sentinel-engine/lib/apex/core';
import { DEFAULT_SCAN_OPTIONS, globalDanger, rankOpportunities } from '@/sentinel-engine/lib/apex/scan';
import { selectSurfacedOpportunity } from '@/sentinel-engine/lib/apex/surface-vetting';
import { derivBus } from '@/sentinel-engine/lib/deriv/tick-bus';
import type { SentinelAiEngine, EngineSample } from './sentinel-ai-engine-types';
import type { EngineInfo } from './sentinel-ai-types';

// Same fail-safe thresholds the Forge used, so "no signal" can be told apart from "cannot see".
const ANALYSIS_LAG_MS = 6_000;
const FEED_STALE_MS = 12_000;
const ENGINE_BUSY_MS = 450;
const API_POLL_MS = 500;
const HEALTH_POLL_MS = 4_000;

const dangerLabel = (value: number) => (value < 35 ? 'CALM' : value < 65 ? 'ELEVATED' : 'HOSTILE');

/**
 * The engine's tick bus binds to the Deriv socket instance that existed when it first attached. Deriv
 * reconnects create a new instance, which would leave the bus listening to a dead socket. Dropping the
 * stale listener lets the bus re-attach on the next subscribe. (Engine code is not modified.)
 */
const resetBusListener = () => {
    try {
        const bus = derivBus as unknown as { messageUnsub: { unsubscribe?: () => void } | null };
        bus.messageUnsub?.unsubscribe?.();
        bus.messageUnsub = null;
    } catch {
        // Best effort.
    }
};

class RealSentinelAiEngine implements SentinelAiEngine {
    private holders = 0;
    private releaseCore: (() => void) | null = null;
    private boundApi: unknown = null;
    private pollTimer: number | null = null;
    private healthTimer: number | null = null;
    private lastSampleCostMs = 0;

    retain() {
        this.holders += 1;
        if (this.holders === 1) this.begin();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.holders = Math.max(0, this.holders - 1);
            if (this.holders === 0) this.end();
        };
    }

    private begin() {
        this.attach();
        this.healthTimer = window.setInterval(() => this.healthCheck(), HEALTH_POLL_MS);
    }

    private end() {
        if (this.healthTimer !== null) window.clearInterval(this.healthTimer);
        if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
        this.healthTimer = null;
        this.pollTimer = null;
        this.detach();
    }

    /** Attaches the engine once the Deriv API exists (the bus cannot seed without it). */
    private attach() {
        if (this.releaseCore) return;
        const api = (api_base as { api?: unknown }).api;
        if (!api) {
            this.pollTimer = window.setTimeout(() => {
                if (this.holders > 0) this.attach();
            }, API_POLL_MS);
            return;
        }
        if (this.boundApi && this.boundApi !== api) resetBusListener();
        this.boundApi = api;
        this.releaseCore = apexCore.subscribe(() => {});
    }

    private detach() {
        this.releaseCore?.();
        this.releaseCore = null;
    }

    /** Re-attaches when the Deriv socket instance was replaced or the engine reports an error state. */
    private healthCheck() {
        if (this.holders === 0) return;
        const api = (api_base as { api?: unknown }).api;
        const replaced = Boolean(api) && Boolean(this.boundApi) && api !== this.boundApi;
        const errored = apexCore.getStatus() === 'error' && Boolean(api);
        if (!replaced && !errored) return;
        this.detach();
        if (replaced) resetBusListener();
        this.attach();
    }

    sample(): EngineSample {
        const t0 = Date.now();
        const intels = apexCore.getAll();
        this.lastSampleCostMs = Date.now() - t0;

        const ranked = rankOpportunities(intels, DEFAULT_SCAN_OPTIONS).ranked;
        const surfaced = selectSurfacedOpportunity(ranked);
        const gd = globalDanger(intels);

        const rawStatus = apexCore.getStatus();
        const status: EngineInfo['status'] =
            rawStatus === 'live' || rawStatus === 'connecting' || rawStatus === 'error' ? rawStatus : 'idle';
        const online = intels.filter(i => i.dataState === 'OK').length;

        const now = Date.now();
        const newestAnalysis = intels.reduce((a, i) => Math.max(a, i.updatedAt || 0), 0);
        const newestTick = intels.reduce((a, i) => Math.max(a, i.lastTickAt || 0), 0);
        const failsafes: string[] = [];
        if (status === 'live' && newestAnalysis > 0 && now - newestAnalysis > ANALYSIS_LAG_MS) failsafes.push('ANALYSIS LAG');
        if (status === 'live' && newestTick > 0 && now - newestTick > FEED_STALE_MS) failsafes.push('FEED STALE');
        if (this.lastSampleCostMs > ENGINE_BUSY_MS) failsafes.push('ENGINE BUSY');
        if (status === 'error' || (status === 'live' && online === 0 && intels.length > 0)) {
            failsafes.push('BACKEND DEGRADED');
        }

        return {
            info: {
                status,
                online,
                total: APEX_UNIVERSE.length,
                degraded: failsafes.length > 0,
                failsafes,
                dangerLabel: dangerLabel(gd),
            },
            surfaced,
        };
    }

    onTick(callback: (symbol: string) => void) {
        return derivBus.onTick(symbol => callback(symbol));
    }

    getLastDigit(symbol: string) {
        const digits = derivBus.getDigits(symbol);
        return digits.length ? digits[digits.length - 1] : null;
    }
}

export const sentinelAiEngine: SentinelAiEngine = new RealSentinelAiEngine();
