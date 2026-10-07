import { useEffect, useMemo, useState } from 'react';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import { useDevice } from '@deriv-com/ui';
import { getTemplateDomain } from '../domain-brand';
import type { PremiumSection } from '../types';

type LauncherItem = { icon: string; label: string; section?: PremiumSection; action?: 'local-file' };

const launcherItems: LauncherItem[] = [
    { icon: '▰', label: 'My computer', action: 'local-file' },
    { icon: '✚', label: 'Bot Builder', section: 'bot_builder' },
    { icon: '🤖', label: 'Free Bots', section: 'free_bots' },
    { icon: '▦', label: 'Bulk Trader', section: 'bulk_trader' },
    { icon: '⇄', label: 'Copy Trading', section: 'copy_trading' },
    { icon: '▥', label: 'Analysis Tool', section: 'analysis_tools' },
];

const DashboardHome = ({ openBotBuilder, openSection }: { openBotBuilder: () => void; openSection?: (section: PremiumSection) => void }) => {
    const { authData } = useApiBase();
    const store = useStore();
    const { isDesktop } = useDevice();
    const domain = getTemplateDomain();
    const [marketCount, setMarketCount] = useState(0);
    const [openContracts, setOpenContracts] = useState(0);
    const [history, setHistory] = useState<any[]>([]);
    const [error, setError] = useState('');

    useEffect(() => {
        Promise.allSettled([
            PremiumDerivApiService.activeSymbols(),
            PremiumDerivApiService.portfolio(),
            PremiumDerivApiService.profitTable(20),
        ]).then(([symbols, portfolio, profit]) => {
            if (symbols.status === 'fulfilled') setMarketCount(symbols.value.length);
            if (portfolio.status === 'fulfilled') setOpenContracts(Array.isArray(portfolio.value.contracts) ? portfolio.value.contracts.length : 0);
            if (profit.status === 'fulfilled') setHistory(Array.isArray(profit.value.transactions) ? profit.value.transactions : []);
            if ([symbols, portfolio, profit].every(item => item.status === 'rejected')) setError('Unable to read the current Deriv session.');
        });
    }, [authData?.loginid]);

    const pnl = useMemo(() => history.reduce((sum, item) => sum + (Number(item.sell_price || 0) - Number(item.buy_price || 0)), 0), [history]);
    const currency = authData?.currency || 'USD';

    const openNativeBotBuilder = () => {
        store?.dashboard?.setActiveTab(DBOT_TABS.BOT_BUILDER);
        store?.run_panel?.toggleDrawer(true);
        openBotBuilder();
    };

    const openLocalBot = () => {
        try {
            store?.dashboard?.setActiveTab(DBOT_TABS.BOT_BUILDER);
            store?.load_modal?.setActiveTabIndex(isDesktop ? 1 : 0);
            store?.load_modal?.toggleLoadModal();
            store?.run_panel?.toggleDrawer(true);
            openBotBuilder();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not open the bot file loader.');
        }
    };

    const launch = (item: LauncherItem) => {
        setError('');
        if (item.action === 'local-file') return openLocalBot();
        if (!item.section) return;
        if (item.section === 'bot_builder') return openNativeBotBuilder();
        openSection?.(item.section);
    };

    return <div className='prodb-dashboard-page'>
        <div className='prodb-dashboard-candles'/>
        <section className='prodb-dashboard-main'>
            <div className='prodb-dashboard-api-strip'>
                <div><small>DERIV ACCOUNT</small><strong>{authData?.loginid || 'Connected'}</strong></div>
                <div><small>LIVE BALANCE</small><strong>{Number(authData?.balance || 0).toFixed(2)} {currency}</strong></div>
                <div><small>ACTIVE MARKETS</small><strong>{marketCount}</strong></div>
                <div><small>OPEN CONTRACTS</small><strong>{openContracts}</strong></div>
                <div><small>LAST 20 NET</small><strong className={pnl >= 0 ? 'is-positive' : 'is-negative'}>{pnl.toFixed(2)} {currency}</strong></div>
            </div>
            <h1>Load or build your bot</h1>
            <p>Load your XML bot from this device or open one of the configured workspace sections.</p>
            <div className='prodb-launchers prodb-launchers--six'>
                {launcherItems.map((item,index)=><button key={item.label} onClick={() => launch(item)}><span className={`launcher-icon launcher-icon--${index}`}>{item.icon}</span><strong>{item.label}</strong></button>)}
            </div>
            {error && <div className='prodb-live-error'>{error}</div>}
        </section>
        <aside className='prodb-help-panel'>
            <article className='prodb-help-panel__welcome'><div className='prodb-help-line'/><span className='prodb-help-icon'>📣</span><h2>Welcome to {domain}</h2><p>Load bots, build Blockly strategies and use the tools configured for this domain.</p></article>
            <article className='prodb-help-card prodb-help-card--green'><span>▣</span><div><h3>My computer</h3><p>Load an XML bot with the existing Bot Builder file loader.</p></div></article>
            <article className='prodb-help-card prodb-help-card--blue'><span>ⓘ</span><div><h3>Bot Builder</h3><p>Blocks, run controls, summary, transactions and journal remain in the Bot Builder workspace.</p></div></article>
        </aside>
    </div>;
};

export default DashboardHome;
