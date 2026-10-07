import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    CurrencyAudIcon,
    CurrencyBtcIcon,
    CurrencyDemoIcon,
    CurrencyEthIcon,
    CurrencyEurIcon,
    CurrencyGbpIcon,
    CurrencyLtcIcon,
    CurrencyNoneIcon,
    CurrencyUsdIcon,
    CurrencyUsdtIcon,
} from '@deriv/quill-icons';
import { observer } from 'mobx-react-lite';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { DerivWSAccountsService, type DerivAccount } from '@/services/derivws-accounts.service';
import { OAuthTokenExchangeService } from '@/services/oauth-token-exchange.service';

const money = (value: string | number, currency = 'USD') => {
    const amount = Number(value);
    return `${Number.isFinite(amount) ? amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'} ${currency}`;
};

const currencyIconMap = {
    usd: CurrencyUsdIcon,
    eur: CurrencyEurIcon,
    gbp: CurrencyGbpIcon,
    aud: CurrencyAudIcon,
    btc: CurrencyBtcIcon,
    eth: CurrencyEthIcon,
    ltc: CurrencyLtcIcon,
    ust: CurrencyUsdtIcon,
    usdt: CurrencyUsdtIcon,
    demo: CurrencyDemoIcon,
};

type MenuPosition = {
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
};

const AccountIcon = ({ account }: { account?: DerivAccount }) => {
    const currencyKey = account?.account_type === 'demo' ? 'demo' : (account?.currency || '').toLowerCase();
    const IconComponent = currencyIconMap[currencyKey as keyof typeof currencyIconMap] || CurrencyNoneIcon;

    return (
        <span className={`prodb-api-account-icon ${account?.account_type === 'demo' ? 'is-demo' : 'is-real'}`} aria-hidden='true'>
            <IconComponent iconSize='sm' />
        </span>
    );
};

const PremiumAccountSwitcher = observer(() => {
    const { activeLoginid, accountList } = useApiBase();
    const { client } = useStore() ?? {};
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuId = useId();
    const [open, setOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
    const [accounts, setAccounts] = useState<DerivAccount[]>(() => DerivWSAccountsService.getStoredAccounts() || []);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    const activeId = activeLoginid || client?.loginid || localStorage.getItem('active_loginid') || '';
    const active = useMemo(() => accounts.find(account => account.account_id === activeId) || accounts[0], [accounts, activeId]);
    const activeAccounts = useMemo(
        () => accounts.filter(account => !account.status || account.status === 'active'),
        [accounts]
    );
    const choices = useMemo(() => {
        const activeReal = active?.account_type === 'real' ? active : undefined;
        const activeDemo = active?.account_type === 'demo' ? active : undefined;
        const real = activeReal || activeAccounts.find(account => account.account_type === 'real');
        const demo = activeDemo || activeAccounts.find(account => account.account_type === 'demo');
        return [real, demo].filter((account): account is DerivAccount => Boolean(account));
    }, [active, activeAccounts]);

    const closeMenu = useCallback(() => {
        setOpen(false);
        setMenuPosition(null);
    }, []);

    const updateMenuPosition = useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger || typeof window === 'undefined') return;

        const rect = trigger.getBoundingClientRect();
        const margin = 8;
        const gap = 6;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const width = Math.max(160, Math.min(258, viewportWidth - margin * 2));
        const maxLeft = Math.max(margin, viewportWidth - width - margin);
        const left = Math.min(Math.max(margin, rect.right - width), maxLeft);
        const roomBelow = Math.max(0, viewportHeight - rect.bottom - gap - margin);
        const roomAbove = Math.max(0, rect.top - gap - margin);

        if (roomBelow >= 190 || roomBelow >= roomAbove) {
            setMenuPosition({
                top: rect.bottom + gap,
                left,
                width,
                maxHeight: Math.max(96, roomBelow),
            });
            return;
        }

        setMenuPosition({
            bottom: viewportHeight - rect.top + gap,
            left,
            width,
            maxHeight: Math.max(96, roomAbove),
        });
    }, []);

    useEffect(() => {
        const handler = (event: MouseEvent | TouchEvent) => {
            const target = event.target as Node;
            if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            closeMenu();
        };
        const keyHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu();
        };

        document.addEventListener('mousedown', handler);
        document.addEventListener('touchstart', handler, { passive: true });
        document.addEventListener('keydown', keyHandler);
        return () => {
            document.removeEventListener('mousedown', handler);
            document.removeEventListener('touchstart', handler);
            document.removeEventListener('keydown', keyHandler);
        };
    }, [closeMenu]);

    useEffect(() => {
        if (!open) return;

        updateMenuPosition();
        const frame = window.requestAnimationFrame(updateMenuPosition);
        const reposition = () => updateMenuPosition();
        window.addEventListener('resize', reposition);
        window.addEventListener('orientationchange', reposition);
        window.addEventListener('scroll', reposition, true);

        return () => {
            window.cancelAnimationFrame(frame);
            window.removeEventListener('resize', reposition);
            window.removeEventListener('orientationchange', reposition);
            window.removeEventListener('scroll', reposition, true);
        };
    }, [open, updateMenuPosition]);

    useEffect(() => {
        if (!open) return;
        const token = OAuthTokenExchangeService.getAccessToken();
        if (!token) return;
        DerivWSAccountsService.refreshAccounts(token)
            .then(setAccounts)
            .catch(err => setError(err instanceof Error ? err.message : String(err)));
    }, [open, accountList?.length]);

    const activeBalance = client?.balance ?? active?.balance ?? 0;
    const activeCurrency = client?.currency || active?.currency || 'USD';

    useEffect(() => {
        if (!activeId) return;

        setAccounts(current =>
            current.map(account =>
                account.account_id === activeId
                    ? {
                          ...account,
                          balance: activeBalance,
                          currency: activeCurrency || account.currency,
                      }
                    : account
            )
        );
    }, [activeBalance, activeCurrency, activeId]);

    const selectAccount = async (account: DerivAccount) => {
        if (account.account_id === activeId || busy) {
            closeMenu();
            return;
        }
        setBusy(account.account_id);
        setError('');
        try {
            localStorage.setItem('active_loginid', account.account_id);
            localStorage.setItem('account_type', account.account_type);
            await client?.regenerateWebSocket?.();
            setAccounts(current => current.map(item => item.account_id === account.account_id ? { ...item, balance: account.balance } : item));
            closeMenu();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy('');
        }
    };

    const balanceFor = (account: DerivAccount) => account.account_id === activeId ? activeBalance : account.balance;

    const menu = open && menuPosition && typeof document !== 'undefined'
        ? createPortal(
            <div
                id={menuId}
                ref={menuRef}
                className='prodb-api-account__menu prodb-api-account__menu--portal'
                role='listbox'
                aria-label='Choose Deriv account'
                style={{
                    position: 'fixed',
                    top: menuPosition.top,
                    bottom: menuPosition.bottom,
                    left: menuPosition.left,
                    width: menuPosition.width,
                    maxHeight: menuPosition.maxHeight,
                }}
            >
                {choices.length === 0 && <div className='prodb-api-account__empty'>No Deriv Options account available.</div>}
                {choices.map(account => {
                    const selected = account.account_id === activeId;
                    return (
                        <button
                            type='button'
                            role='option'
                            aria-selected={selected}
                            key={account.account_id}
                            className={`prodb-api-account__choice ${selected ? 'is-active' : ''}`}
                            disabled={Boolean(busy)}
                            onClick={() => selectAccount(account)}
                        >
                            <AccountIcon account={account} />
                            <span className='prodb-api-account__choice-copy'>
                                <strong>{account.account_type === 'demo' ? 'Demo' : 'Real'}</strong>
                                <small>{account.account_id}</small>
                            </span>
                            <b>{money(balanceFor(account), account.currency || 'USD')}</b>
                            {selected && <span className='prodb-api-account__selected-mark'>✓</span>}
                        </button>
                    );
                })}
                {error && <div className='prodb-api-account__error'>{error}</div>}
            </div>,
            document.body
        )
        : null;

    return (
        <div className='prodb-api-account' ref={rootRef}>
            <button
                ref={triggerRef}
                type='button'
                className='prodb-api-account__trigger'
                onClick={() => {
                    setOpen(value => !value);
                    if (open) setMenuPosition(null);
                }}
                aria-expanded={open}
                aria-haspopup='listbox'
                aria-controls={open ? menuId : undefined}
            >
                <AccountIcon account={active} />
                <span className='prodb-api-account__current'>
                    <small>{active?.account_type === 'demo' ? 'Demo' : 'Real'}</small>
                    <strong>{money(activeBalance, activeCurrency)}</strong>
                </span>
                <span className={`prodb-api-account__chevron ${open ? 'is-open' : ''}`}>⌄</span>
            </button>
            {menu}
        </div>
    );
});

export default PremiumAccountSwitcher;
