import { useEffect, useMemo, useState } from 'react';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';

const preferredSymbols = ['1HZ100V', 'R_100', 'R_10', 'R_25', 'R_50', 'R_75', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V'];
const codeOf = (item: any) => item?.underlying_symbol || item?.symbol || '';
const nameOf = (item: any) => item?.underlying_symbol_name || item?.display_name || codeOf(item);
const decimalsOf = (item: any) => {
    const pip = String(item?.pip_size ?? item?.pip ?? '0.01');
    return pip.includes('.') ? pip.split('.')[1].replace(/0+$/, '').length : 0;
};

const PremiumTicker = ({ light = false }: { light?: boolean }) => {
    const [symbols, setSymbols] = useState<any[]>([]);
    const [quotes, setQuotes] = useState<Record<string, { value: number; previous?: number }>>({});

    useEffect(() => {
        let active = true;
        const disposers: Array<() => void> = [];
        PremiumDerivApiService.activeSymbols().then(async all => {
            if (!active) return;
            const picked = preferredSymbols.map(code => all.find(item => codeOf(item) === code)).filter(Boolean);
            const list = (picked.length >= 6 ? picked : all.filter(item => codeOf(item)).slice(0, 8)).slice(0, 8);
            setSymbols(list);
            await Promise.all(list.map(async item => {
                const code = codeOf(item);
                try {
                    const dispose = await PremiumDerivApiService.subscribeTicks(code, tick => {
                        const next = Number(tick?.quote);
                        if (!Number.isFinite(next)) return;
                        setQuotes(current => ({ ...current, [code]: { value: next, previous: current[code]?.value } }));
                    });
                    if (active) disposers.push(dispose); else dispose();
                } catch { /* individual market can fail without hiding the rest */ }
            }));
        }).catch(() => undefined);
        return () => { active = false; disposers.forEach(dispose => dispose()); };
    }, []);

    const items = useMemo(() => symbols.map((item, index) => {
        const code = codeOf(item), quote = quotes[code], decimals = decimalsOf(item);
        const direction = quote?.previous === undefined || quote.value >= quote.previous ? '▲' : '▼';
        return [nameOf(item).toUpperCase(), quote ? quote.value.toFixed(decimals) : '—', ['cyan','orange','green','blue','blue','red','yellow','green'][index % 8], direction] as const;
    }), [symbols, quotes]);

    if (!items.length) return <div className={`prodb-ticker ${light ? 'prodb-ticker--light' : ''}`} aria-label='Deriv market ticker'><div className='prodb-ticker__track'><div className='prodb-ticker__set'><span className='prodb-ticker__item prodb-ticker__item--green'><b>DERIV MARKET DATA</b><span>CONNECTING…</span></span></div></div></div>;

    return <div className={`prodb-ticker ${light ? 'prodb-ticker--light' : ''}`} aria-label='Live Deriv market ticker'><div className='prodb-ticker__track'>{[0,1].map(set => <div className='prodb-ticker__set' key={set} aria-hidden={set === 1}>{[...items,...items].map(([label,value,tone,arrow],index) => <span className={`prodb-ticker__item prodb-ticker__item--${tone}`} key={`${set}-${index}`}><b>{label}</b><span>{value}</span><i className={arrow === '▲' ? 'up' : 'down'}>{arrow}</i></span>)}</div>)}</div></div>;
};

export default PremiumTicker;
