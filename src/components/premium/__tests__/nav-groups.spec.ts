import { buildNavItems, getGroupForSection, NAV_GROUPS } from '../site-customization';
import type { PremiumSection } from '../types';

const ZENITH: PremiumSection[] = [
    'dashboard', 'bot_builder', 'free_bots', 'manual_trading', 'manual_trader', 'ai_bots', 'auto_trader',
    'sentinel_ai', 'sixfold', 'vanguard', 'ai_intel', 'tradingview', 'bulk_trader', 'copy_trading',
    'calculator', 'analysis_tools', 'digits_analysis',
];

describe('AI Hub navigation group', () => {
    it('is named AI Hub and holds the four engines', () => {
        expect(NAV_GROUPS[0].label).toBe('AI Hub');
        expect(NAV_GROUPS[0].members).toEqual(['sentinel_ai', 'sixfold', 'vanguard', 'ai_intel']);
    });

    it('replaces the four buttons with one group button in the first member slot', () => {
        const items = buildNavItems(ZENITH);
        const ids = items.map(item => (item.type === 'group' ? item.group.id : item.id));
        expect(ids).toEqual([
            'dashboard', 'bot_builder', 'free_bots', 'manual_trading', 'manual_trader', 'ai_bots', 'auto_trader',
            'ai_hub', 'tradingview', 'bulk_trader', 'copy_trading', 'calculator', 'analysis_tools', 'digits_analysis',
        ]);
        expect(items.length).toBe(ZENITH.length - 3);
    });

    it('leaves every other tab untouched and in order', () => {
        const others = buildNavItems(ZENITH).filter(item => item.type === 'section').map(item => (item as { id: string }).id);
        expect(others).toEqual(ZENITH.filter(id => !NAV_GROUPS[0].members.includes(id)));
    });

    it('does not group when fewer than two members are enabled', () => {
        const nav: PremiumSection[] = ['dashboard', 'sentinel_ai', 'tradingview'];
        expect(buildNavItems(nav)).toEqual(nav.map(id => ({ type: 'section', id })));
        expect(getGroupForSection('sentinel_ai', nav)).toBeNull();
    });

    it('only lists members the site enabled', () => {
        const nav: PremiumSection[] = ['dashboard', 'sentinel_ai', 'vanguard'];
        const group = getGroupForSection('vanguard', nav);
        expect(group?.members).toEqual(['sentinel_ai', 'vanguard']);
    });

    it('finds the group for each engine and none for other sections', () => {
        (['sentinel_ai', 'sixfold', 'vanguard', 'ai_intel'] as PremiumSection[]).forEach(section => {
            expect(getGroupForSection(section, ZENITH)?.group.id).toBe('ai_hub');
        });
        expect(getGroupForSection('dashboard', ZENITH)).toBeNull();
        expect(getGroupForSection('bulk_trader', ZENITH)).toBeNull();
    });
});
