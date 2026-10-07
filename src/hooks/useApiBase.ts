import { useEffect, useState } from 'react';
import {
    account_list$,
    authData$,
    CONNECTION_STATUS,
    connectionStatus$,
    isAuthorized$,
    isAuthorizing$,
} from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { TAuthData } from '@/types/api-types';

export const useApiBase = () => {
    const [connectionStatus, setConnectionStatus] = useState<CONNECTION_STATUS>(CONNECTION_STATUS.UNKNOWN);
    const [isAuthorized, setIsAuthorized] = useState<boolean>(false);
    // Start unauthenticated. The premium landing page must be visible until the user
    // explicitly clicks Log in / Sign up or we are processing an OAuth callback.
    const [isAuthorizing, setIsAuthorizing] = useState<boolean>(false);
    const [accountList, setAccountList] = useState<TAuthData['account_list']>([]);
    const [authData, setAuthData] = useState<TAuthData | null>(null);
    const [activeLoginid, setActiveLoginid] = useState<string>('');

    useEffect(() => {
        const connectionStatusSubscription = connectionStatus$.subscribe(status => {
            setConnectionStatus(status as CONNECTION_STATUS);
        });

        const isAuthorizedSubscription = isAuthorized$.subscribe(value => {
            setIsAuthorized(value);
        });

        const isAuthorizingSubscription = isAuthorizing$.subscribe(value => {
            setIsAuthorizing(value);
        });

        const accountListSubscription = account_list$.subscribe(value => {
            setAccountList(value);
        });

        const authDataSubscription = authData$.subscribe(value => {
            setAuthData(value);
            setActiveLoginid(value?.loginid ?? '');
        });

        return () => {
            connectionStatusSubscription.unsubscribe();
            isAuthorizedSubscription.unsubscribe();
            isAuthorizingSubscription.unsubscribe();
            accountListSubscription.unsubscribe();
            authDataSubscription.unsubscribe();
        };
    }, []);

    return { connectionStatus, isAuthorized, isAuthorizing, accountList, authData, activeLoginid, setIsAuthorizing };
};
