/**
 * Utility functions for authentication-related operations.
 */
export const clearAuthData = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('client.country');
    localStorage.removeItem('account_type');
    localStorage.removeItem('accountsList');
    localStorage.removeItem('clientAccounts');
    localStorage.removeItem('callback_token');

    sessionStorage.removeItem('auth_info');
    sessionStorage.removeItem('deriv_accounts');
    sessionStorage.removeItem('oauth_code_verifier');
    sessionStorage.removeItem('oauth_code_verifier_timestamp');
    sessionStorage.removeItem('oauth_csrf_token');
    sessionStorage.removeItem('oauth_csrf_token_timestamp');
    sessionStorage.removeItem('oauth_site_id');
    sessionStorage.removeItem('oauth_redirect_uri');
};
