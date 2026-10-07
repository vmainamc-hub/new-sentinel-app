import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { observer } from 'mobx-react-lite';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { generateOAuthURL } from '@/components/shared';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import AutoTradesPage from '@/pages/auto-trades/auto-trades';
import ManualTradingPage from '@/pages/manual-trading';
import TradingViewPage from '@/pages/tradingview';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';
import BottomStatusBar from './BottomStatusBar';
import { getTemplateDomain } from './domain-brand';
import GlobalAIScannerV2 from './GlobalAIScannerV2';
import GlobalContractBridge from './GlobalContractBridge';
import GlobalQuickTrade from './GlobalQuickTrade';
import LandingPage from './LandingPage';
import PremiumHeader from './PremiumHeader';
import PremiumLoader from './PremiumLoader';
import AIBotsPage from './pages/AIBotsPage';
import AnalysisToolsPage from './pages/AnalysisToolsPage';
import BatchTraderPage from './pages/BatchTraderPage';
import BulkTraderPage from './pages/BulkTraderPage';
import CalculatorPage from './pages/CalculatorPage';
import DigitsAnalysisPage from './pages/DigitsAnalysisPage';
import DashboardHome from './pages/DashboardHome';
import FreeBotsPage from './pages/FreeBotsPage';
import {
    AdvancedManualTradingPage,
    AutoTraderPage,
    BotIdeasPage,
    DTraderPage,
    ProAIPage,
    QuickBotPage,
    SignalAIPage,
    SourceAnalysisToolsPage,
} from './pages/ImportedFeaturePages';
import { ChartsPage } from './pages/LiveTradingPages';
import PatCopyTradingPage from './pages/PatCopyTradingPage';
import SpeedBotPage from './pages/SpeedBotPage';
import { isCustomizableSection, useSiteCustomization } from './site-customization';
import type { PremiumSection } from './types';
import './premium-base.scss';
import './premium-app.scss';
import './premium-live.scss';
import './premium-imported.scss';
import './premium-imported-library.scss';
import './premium-token-panel.scss';
import './premium-native-bot-builder.scss';
import './premium-account.scss';
import './premium-global-trading.scss';
import './premium-mobile-shell.scss';
import './premium-run-panel-right.scss';
import './premium-run-panel-mobile-history.scss';
import './premium-ai-scanner.scss';
import './premium-ai-scanner-override.scss';
import './premium-batch-trader.scss';
import './premium-speed-bot.scss';
import './premium-ai-scanner-v2.scss';
import './premium-execution-fixes.scss';
import './premium-calculator.scss';
import './premium-wallet.scss';
import './premium-site-theme.scss';
import './apex-theme.scss';
import './apex-pages.scss';

const validSections: PremiumSection[] = [
    'dashboard', 'bot_ideas', 'quick_bot', 'bot_builder', 'free_bots', 'signal_ai', 'auto_trader',
    'manual_trading', 'bulk_trader', 'batch_trader', 'copy_trading', 'speedbot', 'calculator', 'pro_ai', 'analysis_tools',
    'analysis_hub', 'charts', 'tradingview', 'dtrader', 'ai_bots', 'digits_analysis',
];

const sectionFromHash = (hash: string): PremiumSection => {
    const value = hash.replace(/^#\/?/, '').split('?')[0] as PremiumSection;
    return validSections.includes(value) ? value : 'dashboard';
};

const isLocalDevelopmentHost = () => ['localhost', '127.0.0.1'].includes(window.location.hostname);

const PremiumLayout = observer(() => {
    const { activeLoginid, isAuthorizing, setIsAuthorizing } = useApiBase();
    const store = useStore();
    const { client, dashboard, run_panel } = store ?? {};
    const location = useLocation();
    const navigate = useNavigate();
    const customization = useSiteCustomization();
    const [section, setSection] = useState<PremiumSection>(() => sectionFromHash(location.hash));
    const [, setAuthProbe] = useState(0);
    const hasBootstrappedSession = useRef(false);

    const params = new URLSearchParams(window.location.search);
    const isOAuthCallback = Boolean(params.get('code') && params.get('state'));
    const hasStoredAuth = OAuthTokenExchangeService.isAuthenticated();
    const runtimeAuthenticated = Boolean(activeLoginid || client?.is_logged_in);
    const isAuthenticated = Boolean(runtimeAuthenticated || hasStoredAuth || isLocalDevelopmentHost());

    useEffect(() => { document.title = getTemplateDomain(); }, []);

    useEffect(() => {
        setSection(sectionFromHash(location.hash));
    }, [location.hash]);

    useEffect(() => {
        if (hasBootstrappedSession.current || isOAuthCallback || !hasStoredAuth || runtimeAuthenticated) return;
        hasBootstrappedSession.current = true;
        setIsAuthorizing(true);

        void OAuthTokenExchangeService.restoreSession()
            .then(restored => {
                if (!restored) {
                    hasBootstrappedSession.current = false;
                    setAuthProbe(value => value + 1);
                }
            })
            .catch(error => {
                hasBootstrappedSession.current = false;
                console.error('Failed to restore authenticated Deriv session:', error);
                setAuthProbe(value => value + 1);
            })
            .finally(() => setIsAuthorizing(false));
    }, [hasStoredAuth, isOAuthCallback, runtimeAuthenticated, setIsAuthorizing]);

    useEffect(() => {
        if ((!isOAuthCallback && !isAuthorizing) || runtimeAuthenticated) return;
        const timer = window.setInterval(() => setAuthProbe(value => value + 1), 500);
        return () => window.clearInterval(timer);
    }, [runtimeAuthenticated, isOAuthCallback, isAuthorizing]);

    const activateNativeBotBuilder = useCallback(() => {
        dashboard?.setActiveTab(DBOT_TABS.BOT_BUILDER);
    }, [dashboard]);

    useEffect(() => {
        if (!isAuthenticated || section !== 'bot_builder') return;

        activateNativeBotBuilder();
        const frame = window.requestAnimationFrame(activateNativeBotBuilder);
        const retry = window.setTimeout(activateNativeBotBuilder, 120);
        const resize = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 220);

        return () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(retry);
            window.clearTimeout(resize);
        };
    }, [activateNativeBotBuilder, isAuthenticated, section]);

    useEffect(() => {
        if (!isAuthenticated) return;
        if (section === 'auto_trader') dashboard?.setActiveTab(DBOT_TABS.AUTO_TRADES);
        if (section === 'manual_trading') dashboard?.setActiveTab(DBOT_TABS.MANUAL_TRADING);
    }, [dashboard, isAuthenticated, section]);

    const startOAuth = useCallback(async (prompt?: string) => {
        try {
            setIsAuthorizing(true);
            const url = await generateOAuthURL(prompt);
            if (url) window.location.replace(url);
            else setIsAuthorizing(false);
        } catch (error) {
            console.error('OAuth redirect failed:', error);
            setIsAuthorizing(false);
        }
    }, [setIsAuthorizing]);

    const changeSection = useCallback((requested: PremiumSection) => {
        const next = isCustomizableSection(requested) && !customization.navigation.includes(requested)
            ? 'dashboard'
            : requested;

        setSection(next);
        navigate(
            {
                pathname: location.pathname,
                search: location.search,
                hash: `#${next}`,
            },
            { replace: true }
        );

        if (next === 'bot_builder') activateNativeBotBuilder();
    }, [activateNativeBotBuilder, customization.navigation, location.pathname, location.search, navigate]);

    useEffect(() => {
        if (!customization.loaded) return;
        if (isCustomizableSection(section) && !customization.navigation.includes(section)) {
            changeSection('dashboard');
        }
    }, [changeSection, customization.loaded, customization.navigation, section]);

    if (!runtimeAuthenticated && (isOAuthCallback || isAuthorizing || hasStoredAuth)) return <PremiumLoader />;
    if (!isAuthenticated) return <LandingPage onLogin={() => startOAuth()} onSignup={() => startOAuth('registration')} busy={isAuthorizing} />;

    const openBotBuilder = () => changeSection('bot_builder');
    const renderSection = () => {
        switch (section) {
            case 'dashboard': return <DashboardHome openBotBuilder={openBotBuilder} openSection={changeSection} />;
            case 'bot_ideas': return <BotIdeasPage openBotBuilder={openBotBuilder} />;
            case 'quick_bot': return <QuickBotPage openBotBuilder={openBotBuilder} openSection={changeSection} />;
            case 'bot_builder': return null;
            case 'free_bots': return <FreeBotsPage openBotBuilder={openBotBuilder} />;
            case 'signal_ai': return <SignalAIPage />;
            case 'auto_trader': return <AutoTradesPage />;
            case 'manual_trading': return <ManualTradingPage />;
            case 'bulk_trader': return <BulkTraderPage />;
            case 'batch_trader': return <BatchTraderPage />;
            case 'copy_trading': return <PatCopyTradingPage />;
            case 'speedbot': return <SpeedBotPage />;
            case 'calculator': return <CalculatorPage />;
            case 'pro_ai': return <ProAIPage />;
            case 'analysis_tools': return <AnalysisToolsPage />;
            case 'analysis_hub': return <SourceAnalysisToolsPage />;
            case 'charts': return <ChartsPage />;
            case 'tradingview': return <TradingViewPage />;
            case 'dtrader': return <DTraderPage />;
            case 'ai_bots': return <AIBotsPage />;
            case 'digits_analysis': return <DigitsAnalysisPage />;
            default: return null;
        }
    };

    const isBotBuilder = section === 'bot_builder';
    const isRunPanelOpen = Boolean(run_panel?.is_drawer_open);
    const themeStyle = {
        '--site-primary': customization.colors.primary,
        '--site-secondary': customization.colors.secondary,
        '--site-nav-background': customization.colors.nav_background,
        '--site-nav-text': customization.colors.nav_text,
        '--site-header-background': customization.colors.header_background,
    } as CSSProperties;

    return <div
        className={`prodb-premium-shell ${isBotBuilder ? 'prodb-premium-shell--builder' : ''} ${isRunPanelOpen ? 'prodb-premium-shell--run-open' : ''}`}
        style={themeStyle}
    >
        <GlobalContractBridge />
        <PremiumHeader active={section} navigation={customization.navigation} onChange={changeSection} />
        <main className='prodb-premium-content'>
            {!isBotBuilder && renderSection()}
            <div className={`prodb-bot-builder-host ${isBotBuilder ? 'is-active' : 'is-hidden'}`} data-premium-builder-active={isBotBuilder ? 'true' : 'false'}>
                <Outlet />
            </div>
        </main>
        <GlobalAIScannerV2 openBotBuilder={openBotBuilder} />
        <GlobalQuickTrade hidden={isBotBuilder} />
        {!isBotBuilder && <BottomStatusBar onOpenBotBuilder={openBotBuilder} />}
    </div>;
});

export default PremiumLayout;
