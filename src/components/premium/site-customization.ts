import { useEffect, useMemo, useState } from 'react';
import { getCurrentSiteConfig } from '@/config/site-registry';
import type { PremiumSection } from './types';

export type SiteThemeColors = {
    primary: string;
    secondary: string;
    nav_background: string;
    nav_text: string;
    header_background: string;
};

export type SiteCustomization = {
    navigation: PremiumSection[];
    colors: SiteThemeColors;
    loaded: boolean;
};

export const NAVIGATION_CATALOG: Array<{ id: PremiumSection; label: string; required?: boolean }> = [
    { id: 'dashboard', label: 'Dashboard', required: true },
    { id: 'bot_builder', label: 'Bot Builder' },
    { id: 'free_bots', label: 'Free Bots' },
    { id: 'auto_trader', label: 'Auto Trades' },
    { id: 'sentinel_ai', label: 'Sentinel AI' },
    { id: 'sixfold', label: 'Sixfold' },
    { id: 'vanguard', label: 'Vanguard' },
    { id: 'ai_intel', label: 'Apex Intel' },
    { id: 'elite_prime', label: 'Elite Prime' },
    { id: 'overlord', label: 'Overlord Pro' },
    { id: 'signal_tools', label: 'Signal Tools' },
    { id: 'manual_trading', label: 'DTrader' },
    { id: 'manual_trader', label: 'Manual Trader' },
    { id: 'tradingview', label: 'TradingView' },
    { id: 'bulk_trader', label: 'Bulk Trader' },
    { id: 'batch_trader', label: 'Batch Trader' },
    { id: 'speedbot', label: 'Speed Bot' },
    { id: 'copy_trading', label: 'Copy Trading' },
    { id: 'analysis_tools', label: 'Analysis Tool' },
    { id: 'calculator', label: 'Calculator' },
    { id: 'ai_bots', label: 'AI Bots' },
    { id: 'digits_analysis', label: 'Digits Analysis' },
];

export const DEFAULT_NAVIGATION: PremiumSection[] = [
    'dashboard',
    'bot_builder',
    'free_bots',
    'manual_trading',
    'ai_bots',
    'auto_trader',
    'sentinel_ai',
    'tradingview',
    'bulk_trader',
    'copy_trading',
    'calculator',
    'analysis_tools',
    'digits_analysis',
];

// Tabs that share one top-bar button. Members keep their own section ids (hashes, Run Panel hand-offs and bridges are unchanged);
// only the way they are laid out in the top bar differs. To add another group or move an app into one, edit this list.
export type NavGroup = { id: string; label: string; members: PremiumSection[] };

export const NAV_GROUPS: NavGroup[] = [
    { id: 'ai_hub', label: 'AI Hub', members: ['sentinel_ai', 'sixfold', 'vanguard', 'ai_intel'] },
];

export type NavItem =
    | { type: 'section'; id: PremiumSection }
    | { type: 'group'; group: NavGroup; members: PremiumSection[] };

// A group only forms when at least two of its members are enabled for the site. Otherwise its tab is left as a normal tab,
// so a site that only lists one of the apps looks exactly as it did before.
export const getVisibleGroupMembers = (group: NavGroup, navigation: PremiumSection[]) =>
    group.members.filter(member => navigation.includes(member));

export const getGroupForSection = (section: PremiumSection, navigation: PremiumSection[]) => {
    const group = NAV_GROUPS.find(candidate => candidate.members.includes(section));
    if (!group) return null;
    const members = getVisibleGroupMembers(group, navigation);
    return members.length >= 2 && members.includes(section) ? { group, members } : null;
};

// Turns the flat navigation list into top-bar items. The group button takes the place of its first enabled member.
export const buildNavItems = (navigation: PremiumSection[]): NavItem[] => {
    const items: NavItem[] = [];
    const placed = new Set<string>();

    navigation.forEach(id => {
        const group = NAV_GROUPS.find(candidate => candidate.members.includes(id));
        const members = group ? getVisibleGroupMembers(group, navigation) : [];
        if (!group || members.length < 2) {
            items.push({ type: 'section', id });
            return;
        }
        if (placed.has(group.id)) return;
        placed.add(group.id);
        items.push({ type: 'group', group, members });
    });

    return items;
};

const GROUP_TAB_KEY = 'prodb-nav-group-last:';

// Browser storage can be unavailable (private windows, blocked site data), so every access is guarded.
export const readGroupTab = (groupId: string): PremiumSection | null => {
    try {
        return (window.localStorage.getItem(GROUP_TAB_KEY + groupId) as PremiumSection | null) || null;
    } catch {
        return null;
    }
};

export const rememberGroupTab = (groupId: string, section: PremiumSection) => {
    try {
        window.localStorage.setItem(GROUP_TAB_KEY + groupId, section);
    } catch {
        // Not remembering the last tab is harmless.
    }
};

const CATALOG_ID_LIST = NAVIGATION_CATALOG.map(item => item.id);

export const DEFAULT_THEME_COLORS: SiteThemeColors = {
    primary: '#e8b84a',
    secondary: '#e8b84a',
    nav_background: '#07101f',
    nav_text: '#f3f6fb',
    header_background: '#050a14',
};

const CATALOG_IDS = new Set(CATALOG_ID_LIST);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const isCustomizableSection = (section: PremiumSection) => CATALOG_IDS.has(section);

const normalizeNavigation = (value: unknown): PremiumSection[] => {
    if (!Array.isArray(value)) return [...DEFAULT_NAVIGATION];

    const seen = new Set<PremiumSection>();
    const navigation = value
        .map(item => String(item) as PremiumSection)
        .filter(item => CATALOG_IDS.has(item) && !seen.has(item) && Boolean(seen.add(item)));

    // Dashboard is the safe landing destination and cannot be removed by a domain configuration.
    if (!navigation.includes('dashboard')) navigation.unshift('dashboard');
    return navigation.length ? navigation : ['dashboard'];
};

const normalizeColors = (value: unknown): SiteThemeColors => {
    const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const next = { ...DEFAULT_THEME_COLORS };

    (Object.keys(next) as Array<keyof SiteThemeColors>).forEach(key => {
        const color = String(candidate[key] ?? '');
        if (HEX_COLOR.test(color)) next[key] = color.toLowerCase();
    });

    return next;
};

const readJson = async (urls: string[]) => {
    for (const url of urls) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (response.ok) return response.json();
            if (response.status !== 404) console.warn(`Site customization request failed (${response.status}): ${url}`);
        } catch (error) {
            console.warn(`Site customization request failed: ${url}`, error);
        }
    }
    return null;
};

export const useSiteCustomization = (): SiteCustomization => {
    const site = getCurrentSiteConfig();
    const [state, setState] = useState<SiteCustomization>({
        navigation: [...DEFAULT_NAVIGATION],
        colors: { ...DEFAULT_THEME_COLORS },
        loaded: false,
    });

    const domainConfigUrl = useMemo(
        () => `/site-config/domains/${encodeURIComponent(site.id)}.json`,
        [site.id]
    );

    useEffect(() => {
        let alive = true;

        void readJson([domainConfigUrl]).then(payload => {
            if (!alive) return;
            setState({
                navigation: normalizeNavigation(payload?.navigation),
                colors: normalizeColors(payload?.colors),
                loaded: true,
            });
        });

        return () => {
            alive = false;
        };
    }, [domainConfigUrl]);

    return state;
};
