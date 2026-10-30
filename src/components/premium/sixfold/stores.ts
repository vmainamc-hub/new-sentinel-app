// The Run Panel / transactions / dashboard stores a trading runner needs, as narrow interfaces (so runners are unit-testable).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

export interface RunPanelLike {
    run_id?: string;
    is_contract_buying_in_progress: boolean;
    setIsRunning: (value: boolean) => void;
    setRunId: (id: string) => void;
    setContractStage?: (stage: number) => void;
    toggleDrawer: (open: boolean) => void;
    setHasOpenContract?: (value: boolean) => void;
    setShowBotStopMessage?: (value: boolean) => void;
    onBotContractEvent: (data: Loose) => void;
}

export interface RunnerStores {
    /** Account currency source (same one Auto Trades reads). Falls back to USD when unavailable. */
    client?: { currency?: string };
    run_panel: RunPanelLike;
    summary_card: { onBotContractEvent: (data: Loose) => void };
    transactions: { pushTransaction: (data: Loose) => void };
    dashboard: {
        active_trading_module: string | null;
        setActiveTradingModule: (id: string | null) => void;
        registerTradingStopHandler: (id: string, handler: () => void) => void;
        unregisterTradingStopHandler: (id: string) => void;
        stopActiveTradingModule: () => void;
    };
}

export type StoreWatcher = (onChange: (runPanelRunning: boolean, activeModule: string | null) => void) => () => void;
