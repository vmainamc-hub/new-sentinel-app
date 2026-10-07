import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { observer } from 'mobx-react-lite';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import BrandMark from './BrandMark';
import PremiumAccountSwitcher from './PremiumAccountSwitcher';
import { BoltIcon, CalculatorIcon, CopyIcon, GearIcon, GridIcon, HomeIcon, MoonIcon, RobotIcon, SearchIcon, SunIcon } from './icons';
import { NAVIGATION_CATALOG } from './site-customization';
import PremiumTicker from './PremiumTicker';
import type { PremiumSection } from './types';

const NAV_ICONS: Partial<Record<PremiumSection, typeof HomeIcon>> = {
    dashboard: HomeIcon,
    bot_builder: GearIcon,
    free_bots: RobotIcon,
    auto_trader: RobotIcon,
    manual_trading: BoltIcon,
    tradingview: SearchIcon,
    bulk_trader: GridIcon,
    batch_trader: GridIcon,
    speedbot: GridIcon,
    copy_trading: CopyIcon,
    analysis_tools: SearchIcon,
    calculator: CalculatorIcon,
};

const NAV_LABELS = Object.fromEntries(NAVIGATION_CATALOG.map(item => [item.id, item.label])) as Partial<Record<PremiumSection, string>>;

const PremiumHeader = observer(
    ({ active, navigation, onChange }: { active: PremiumSection; navigation: PremiumSection[]; onChange: (section: PremiumSection) => void }) => {
        const navRef = useRef<HTMLElement | null>(null);
        const dragRef = useRef({ active: false, pointerId: -1, startX: 0, scrollLeft: 0, moved: false });
        const suppressClickRef = useRef(false);
        const { is_dark_mode_on, toggleTheme } = useThemeSwitcher();

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
                    {navigation.map(id => {
                        const Icon = NAV_ICONS[id];
                        const label = NAV_LABELS[id];
                        if (!Icon || !label) return null;
                        return (
                            <button key={id} className={active === id ? 'is-active' : ''} onClick={() => onNavClick(id)}>
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
