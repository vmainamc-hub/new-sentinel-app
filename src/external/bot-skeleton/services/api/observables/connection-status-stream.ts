// connection-status-stream.ts (This will manage our observable stream)
import { BehaviorSubject } from 'rxjs';
import { TAuthData } from '@/types/api-types';

export enum CONNECTION_STATUS {
    OPENED = 'opened',
    CLOSED = 'closed',
    UNKNOWN = 'unknown',
}

export const connectionStatus$ = new BehaviorSubject<string>('unknown');
// Authentication begins only after an explicit login/signup action or callback.
export const isAuthorizing$ = new BehaviorSubject<boolean>(false);
export const isAuthorized$ = new BehaviorSubject<boolean>(false);
export const account_list$ = new BehaviorSubject<TAuthData['account_list']>([]);
export const authData$ = new BehaviorSubject<TAuthData | null>(null);

export const setConnectionStatus = (status: CONNECTION_STATUS) => {
    connectionStatus$.next(status);
};

export const setIsAuthorized = (isAuthorized: boolean) => {
    isAuthorized$.next(isAuthorized);
};

export const setIsAuthorizing = (isAuthorizing: boolean) => {
    isAuthorizing$.next(isAuthorizing);
};

export const setAccountList = (accountList: TAuthData['account_list']) => {
    account_list$.next(accountList);
};

export const setAuthData = (authData: TAuthData | null) => {
    if (authData?.loginid) localStorage.setItem('active_loginid', authData.loginid);
    authData$.next(authData);
};

export const updateAuthBalance = (loginid: string, balance: number, currency?: string) => {
    const current = authData$.value;
    if (!current || current.loginid !== loginid) return;

    authData$.next({
        ...current,
        balance,
        currency: currency || current.currency,
        account_list: current.account_list?.map(account =>
            account.loginid === loginid
                ? {
                      ...account,
                      balance,
                      currency: currency || account.currency,
                  }
                : account
        ),
    });
};
