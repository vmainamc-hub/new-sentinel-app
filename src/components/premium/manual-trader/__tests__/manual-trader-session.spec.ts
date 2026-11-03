import {
    MANUAL_TRADER_BASE_PATH,
    MANUAL_TRADER_MANIFEST_URL,
    buildTraderAccounts,
    buildTraderLoginQuery,
    buildTraderSession,
    buildTraderUrl,
    parseManifest,
    toTraderLoginid,
    usableAccounts,
} from '../manual-trader-session';

const demo = { account_id: 'DOT92307170', balance: '10000', currency: 'USD', account_type: 'demo', status: 'active' };
const real = { account_id: 'ROT91139228', balance: '12.5', currency: 'USD', account_type: 'real', status: 'active' };
const closed = { account_id: 'ROT1', balance: '0', currency: 'USD', account_type: 'real', status: 'disabled' };

describe('manual trader paths', () => {
    it('serves from a br_ folder, the only base path the DTrader router accepts', () => {
        expect(MANUAL_TRADER_BASE_PATH).toMatch(/^\/br_[^/]+\/$/);
        expect(MANUAL_TRADER_MANIFEST_URL).toBe(`${MANUAL_TRADER_BASE_PATH}manual-trader.json`);
    });
});

describe('parseManifest', () => {
    it('accepts the JSON the build script writes', () => {
        expect(parseManifest({ source_commit: 'abc123', built_at: '2026-11-04' })).toEqual({
            source_commit: 'abc123',
            built_at: '2026-11-04',
        });
    });
    it('rejects anything else, such as a fallback page', () => {
        expect(parseManifest(null)).toBeNull();
        expect(parseManifest('<html></html>')).toBeNull();
        expect(parseManifest({})).toBeNull();
        expect(parseManifest({ source_commit: '' })).toBeNull();
    });
});

describe('accounts', () => {
    it('keeps only active accounts that have an id', () => {
        expect(usableAccounts([demo, closed, { account_id: '' } as any])).toEqual([demo]);
        expect(usableAccounts(null)).toEqual([]);
    });
    it('maps new account ids to the legacy aliases', () => {
        expect(toTraderLoginid('DOT92307170', 'demo')).toBe('VRTC92307170');
        expect(toTraderLoginid('ROT91139228', 'real')).toBe('CR91139228');
    });
    it('wraps accounts like the /options/accounts response', () => {
        expect(buildTraderAccounts([demo, closed])).toEqual({ data: [demo] });
    });
});

describe('session', () => {
    it('needs an access token', () => {
        expect(buildTraderSession(null)).toBeNull();
        expect(buildTraderSession({})).toBeNull();
        expect(buildTraderSession({ access_token: 't', expires_at: 99 })).toEqual({ access_token: 't', expires_at: 99 });
        expect(buildTraderSession({ access_token: 't' })).toEqual({ access_token: 't', expires_at: 0 });
    });
});

describe('login query', () => {
    it('lists demo first and selects it by default', () => {
        const params = new URLSearchParams(buildTraderLoginQuery([real, demo]));
        expect(params.get('acct1')).toBe('VRTC92307170');
        expect(params.get('token1')).toBe('oauth:DOT92307170');
        expect(params.get('cur1')).toBe('USD');
        expect(params.get('acct2')).toBe('CR91139228');
        expect(params.get('token2')).toBe('oauth:ROT91139228');
        expect(params.get('selected_acct')).toBe('VRTC92307170');
    });
    it('selects the account the app is already on', () => {
        const params = new URLSearchParams(buildTraderLoginQuery([demo, real], 'ROT91139228'));
        expect(params.get('selected_acct')).toBe('CR91139228');
    });
    it('falls back to demo when the active account is not in the list', () => {
        const params = new URLSearchParams(buildTraderLoginQuery([demo, real], 'unknown'));
        expect(params.get('selected_acct')).toBe('VRTC92307170');
    });
    it('never puts a bearer token in the address', () => {
        expect(buildTraderLoginQuery([demo, real])).not.toMatch(/access_token|Bearer/i);
    });
    it('is empty without accounts', () => {
        expect(buildTraderLoginQuery([])).toBe('');
        expect(buildTraderUrl('')).toBe(MANUAL_TRADER_BASE_PATH);
        expect(buildTraderUrl('a=1')).toBe(`${MANUAL_TRADER_BASE_PATH}?a=1`);
    });
});
