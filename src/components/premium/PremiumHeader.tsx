import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { observer } from 'mobx-react-lite';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import BrandMark from './BrandMark';
import PremiumAccountSwitcher from './PremiumAccountSwitcher';
import { BoltIcon, CalculatorIcon, CopyIcon, GearIcon, GridIcon, HomeIcon, MonitorIcon, MoonIcon, PulseIcon, RobotIcon, SearchIcon, ShieldIcon, SunIcon } from './icons';
import { buildNavItems, getGroupForSection, NAVIGATION_CATALOG, readGroupTab, rememberGroupTab } from './site-customization';
import PremiumTicker from './PremiumTicker';
import type { PremiumSection } from './types';

const NAV_ICONS: Partial<Record<PremiumSection, typeof HomeIcon>> = {
    dashboard: HomeIcon,
    bot_builder: GearIcon,
    free_bots: RobotIcon,
    auto_trader: RobotIcon,
    sentinel_ai: ShieldIcon,
    manual_trading: BoltIcon,
    manual_trader: MonitorIcon,
    tradingview: SearchIcon,
    bulk_trader: GridIcon,
    batch_trader: GridIcon,
    speedbot: GridIcon,
    copy_trading: CopyIcon,
    analysis_tools: SearchIcon,
    calculator: CalculatorIcon,
    ai_bots: RobotIcon,
    digits_analysis: SearchIcon,
    sixfold: PulseIcon,
    ai_intel: SearchIcon,
    elite_prime: RobotIcon,
    overlord: BoltIcon,
    signal_tools: SearchIcon,
};

const NAV_LABELS = Object.fromEntries(NAVIGATION_CATALOG.map(item => [item.id, item.label])) as Partial<Record<PremiumSection, string>>;

const PremiumHeader = observer(
    ({ active, navigation, onChange }: { active: PremiumSection; navigation: PremiumSection[]; onChange: (section: PremiumSection) => void }) => {
        const navRef = useRef<HTMLElement | null>(null);
        const dragRef = useRef({ active: false, pointerId: -1, startX: 0, scrollLeft: 0, moved: false });
        const suppressClickRef = useRef(false);
        const { is_dark_mode_on, toggleTheme } = useThemeSwitcher();
        const [canScrollLeft, setCanScrollLeft] = useState(false);
        const [canScrollRight, setCanScrollRight] = useState(false);

        const updateScrollState = useCallback(() => {
            const nav = navRef.current;
            if (!nav) return;
            setCanScrollLeft(nav.scrollLeft > 2);
            setCanScrollRight(nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
        }, []);

        useEffect(() => {
            const nav = navRef.current;
            if (!nav) return undefined;
            updateScrollState();
            nav.addEventListener('scroll', updateScrollState, { passive: true });
            window.addEventListener('resize', updateScrollState);
            const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollState) : null;
            resizeObserver?.observe(nav);
            return () => {
                nav.removeEventListener('scroll', updateScrollState);
                window.removeEventListener('resize', updateScrollState);
                resizeObserver?.disconnect();
            };
        }, [navigation, updateScrollState]);

        // Keep the active tab visible (e.g. when a section is opened from the dashboard).
        useEffect(() => {
            navRef.current?.querySelector<HTMLElement>('button.is-active')?.scrollIntoView?.({
                block: 'nearest',
                inline: 'nearest',
            });
        }, [active]);

        const navItems = useMemo(() => buildNavItems(navigation), [navigation]);

        // Remember the last tab opened inside each group, so clicking the group button returns to it.
        useEffect(() => {
            const found = getGroupForSection(active, navigation);
            if (found) rememberGroupTab(found.group.id, active);
        }, [active, navigation]);

        const getGroupTarget = (groupId: string, members: PremiumSection[]) => {
            const last = readGroupTab(groupId);
            return last && members.includes(last) ? last : members[0];
        };

        const scrollNav = (direction: -1 | 1) => {
            const nav = navRef.current;
            if (!nav) return;
            nav.scrollBy({ left: direction * Math.max(200, nav.clientWidth * 0.6), behavior: 'smooth' });
        };

        const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
            if (event.pointerType !== 'mouse' || event.button !== 0 || !navRef.current) return;

            dragRef.current = {
                active: true,
                pointerId: event.pointerId,
                startX: event.clientX,
                scrollLeft: navRef.current.scrollLeft,
                moved: false,
            };
        };

        const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
            const nav = navRef.current;
            const drag = dragRef.current;
            if (!nav || !drag.active || drag.pointerId !== event.pointerId) return;

            const delta = event.clientX - drag.startX;
            if (!drag.moved && Math.abs(delta) <= 6) return;

            if (!drag.moved) {
                drag.moved = true;
                nav.setPointerCapture?.(event.pointerId);
            }

            event.preventDefault();
            nav.scrollLeft = drag.scrollLeft - delta;
        };

        const endPointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
            const nav = navRef.current;
            const wasDragged = dragRef.current.active && dragRef.current.moved;

            if (nav?.hasPointerCapture?.(event.pointerId)) nav.releasePointerCapture(event.pointerId);
            dragRef.current.active = false;

            if (wasDragged) {
                suppressClickRef.current = true;
                window.setTimeout(() => {
                    suppressClickRef.current = false;
                }, 0);
            }
        };

        const onNavClick = (section: PremiumSection) => {
            if (suppressClickRef.current) return;
            onChange(section);
        };

        return (
            <>
                <div className='prodb-app-header'>
                    <button className='prodb-app-header__brand' onClick={() => onChange('dashboard')}>
                        <BrandMark />
                    </button>
                    <div className='prodb-app-header__actions'>
                        <button
                            type='button'
                            className={`prodb-theme-toggle ${is_dark_mode_on ? 'is-dark' : 'is-light'}`}
                            onClick={toggleTheme}
                            aria-label={is_dark_mode_on ? 'Switch to light mode' : 'Switch to dark mode'}
                            title={is_dark_mode_on ? 'Light mode' : 'Dark mode'}
                            aria-pressed={is_dark_mode_on}
                        >
                            {is_dark_mode_on ? <MoonIcon /> : <SunIcon />}
                        </button>
                        <PremiumAccountSwitcher />
                    </div>
                </div>
                <nav
                    ref={navRef}
                    className='prodb-nav'
                    aria-label='Site tools'
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endPointerDrag}
                    onPointerCancel={endPointerDrag}
                >
                    {navItems.map(item => {
                        if (item.type === 'group') {
                            const { group, members } = item;
                            const isGroupActive = members.includes(active);
                            return (
                                <button
                                    key={group.id}
                                    className={isGroupActive ? 'is-active' : ''}
                                    aria-pressed={isGroupActive}
                                    title={members.map(member => NAV_LABELS[member]).filter(Boolean).join(' · ')}
                                    onClick={() => onNavClick(isGroupActive ? active : getGroupTarget(group.id, members))}
                                >
                                    <PulseIcon />
                                    <span>{group.label}</span>
                                </button>
                            );
                        }
                        const Icon = NAV_ICONS[item.id];
                        const label = NAV_LABELS[item.id];
                        if (!Icon || !label) return null;
                        return (
                            <button key={item.id} className={active === item.id ? 'is-active' : ''} onClick={() => onNavClick(item.id)}>
                                <Icon />
                                <span>{label}</span>
                            </button>
                        );
                    })}
                </nav>
                <PremiumTicker light />
            </>
        );
    }
);

export default PremiumHeader;
