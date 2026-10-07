import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'prodb.risk-calculator.v1';

type CalculatorSettings = {
    capital: number;
    stakePercent: number;
    martingale: number;
    takeProfitPercent: number;
    stopLossPercent: number;
};

const DEFAULTS: CalculatorSettings = {
    capital: 100,
    stakePercent: 4,
    martingale: 0.5,
    takeProfitPercent: 15,
    stopLossPercent: 25,
};

const readSettings = (): CalculatorSettings => {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (parsed && typeof parsed === 'object') return { ...DEFAULTS, ...parsed };
    } catch {
        // Ignore malformed local preferences.
    }
    return DEFAULTS;
};

const numeric = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const money = (value: number) => Number.isFinite(value) ? value.toFixed(2) : '0.00';

const CalculatorPage = () => {
    const [settings, setSettings] = useState<CalculatorSettings>(readSettings);

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* preferences only */ }
    }, [settings]);

    const results = useMemo(() => {
        const capital = Math.max(0, numeric(settings.capital));
        return {
            stake: capital * Math.max(0, numeric(settings.stakePercent)) / 100,
            stopLoss: capital * Math.max(0, numeric(settings.stopLossPercent)) / 100,
            takeProfit: capital * Math.max(0, numeric(settings.takeProfitPercent)) / 100,
        };
    }, [settings]);

    const update = (key: keyof CalculatorSettings, value: number) => {
        setSettings(current => ({ ...current, [key]: value }));
    };

    return (
        <div className='prodb-calculator-page'>
            <section className='prodb-calculator-card'>
                <div className='prodb-calculator-heading'>
                    <span>RISK CALCULATOR</span>
                    <h1>Calculate and manage your trading risk positions with precision</h1>
                    <p>Set your capital and preferred percentages. The calculator updates your stake, stop loss and take profit instantly.</p>
                </div>

                <div className='prodb-calculator-plan'>
                    <strong>Your Risk Management Plan</strong>
                    <ul>
                        <li>Stake Percentage: {settings.stakePercent}% of capital</li>
                        <li>Martingale: {settings.martingale}</li>
                        <li>Take profit: {settings.takeProfitPercent}% of capital</li>
                        <li>Stop loss: {settings.stopLossPercent}% of capital</li>
                    </ul>
                </div>

                <div className='prodb-calculator-grid'>
                    <label>
                        <span>CAPITAL INVESTED ($)</span>
                        <input
                            type='number'
                            min='0'
                            step='1'
                            value={settings.capital}
                            onChange={event => update('capital', Math.max(0, numeric(event.target.value)))}
                        />
                    </label>
                    <label>
                        <span>STAKE PERCENTAGE (%)</span>
                        <input
                            type='number'
                            min='0'
                            step='.1'
                            value={settings.stakePercent}
                            onChange={event => update('stakePercent', Math.max(0, numeric(event.target.value)))}
                        />
                    </label>
                    <label>
                        <span>STOP LOSS (%)</span>
                        <input
                            type='number'
                            min='0'
                            step='.1'
                            value={settings.stopLossPercent}
                            onChange={event => update('stopLossPercent', Math.max(0, numeric(event.target.value)))}
                        />
                    </label>
                    <label>
                        <span>TAKE PROFIT (%)</span>
                        <input
                            type='number'
                            min='0'
                            step='.1'
                            value={settings.takeProfitPercent}
                            onChange={event => update('takeProfitPercent', Math.max(0, numeric(event.target.value)))}
                        />
                    </label>
                    <label>
                        <span>MARTINGALE</span>
                        <input
                            type='number'
                            min='0'
                            step='.1'
                            value={settings.martingale}
                            onChange={event => update('martingale', Math.max(0, numeric(event.target.value)))}
                        />
                    </label>
                </div>

                <div className='prodb-calculator-results'>
                    <h2>Results</h2>
                    <div><span>Amount to Stake ($)</span><strong>{money(results.stake)}</strong></div>
                    <div><span>Stop Loss ($)</span><strong>{money(results.stopLoss)}</strong></div>
                    <div><span>Take Profit ($)</span><strong>{money(results.takeProfit)}</strong></div>
                </div>
            </section>
        </div>
    );
};

export default CalculatorPage;
