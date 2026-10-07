import brandConfig from '../../brand.config.json' with { type: 'json' };

const json = (statusCode, body, origin = '*') => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        Vary: 'Origin',
    },
    body: JSON.stringify(body),
});

const normalizeHost = value => String(value || '').trim().toLowerCase().replace(/^www\./, '');

const findSite = siteId => brandConfig.sites.entries.find(site => site.id === siteId);

const hostFromOrigin = origin => {
    try {
        return normalizeHost(new URL(origin).hostname);
    } catch {
        return '';
    }
};

export const handler = async event => {
    const origin = event.headers?.origin || '';

    if (event.httpMethod === 'OPTIONS') return json(204, {}, origin || '*');
    if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' }, origin || '*');

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'invalid_request', error_description: 'Request body must be JSON.' }, origin || '*');
    }

    const site = findSite(payload.site_id);
    if (!site) {
        return json(400, { error: 'site_not_configured', error_description: 'Unknown OAuth site configuration.' }, origin || '*');
    }

    const requestHost = hostFromOrigin(origin) || normalizeHost(event.headers?.host);
    const allowedHosts = site.hosts.map(normalizeHost);
    if (!requestHost || !allowedHosts.includes(requestHost)) {
        return json(
            403,
            { error: 'origin_not_allowed', error_description: `OAuth site ${site.id} is not allowed on this host.` },
            origin || '*'
        );
    }

    const authBase = brandConfig.platform.auth2_url[site.environment];
    if (!authBase) {
        return json(500, { error: 'server_configuration_error', error_description: 'OAuth base URL is not configured.' }, origin);
    }

    const form = new URLSearchParams();
    const grantType = payload.grant_type;

    if (grantType === 'authorization_code') {
        if (!payload.code || !payload.code_verifier) {
            return json(400, { error: 'invalid_request', error_description: 'code and code_verifier are required.' }, origin);
        }

        form.set('grant_type', 'authorization_code');
        form.set('client_id', site.client_id);
        form.set('code', payload.code);
        form.set('code_verifier', payload.code_verifier);
        form.set('redirect_uri', site.redirect_uri);
    } else if (grantType === 'refresh_token') {
        if (!payload.refresh_token) {
            return json(400, { error: 'invalid_request', error_description: 'refresh_token is required.' }, origin);
        }

        form.set('grant_type', 'refresh_token');
        form.set('client_id', site.client_id);
        form.set('refresh_token', payload.refresh_token);
    } else {
        return json(400, { error: 'unsupported_grant_type' }, origin);
    }

    try {
        const tokenResponse = await fetch(new URL('token', authBase), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: form.toString(),
        });

        const raw = await tokenResponse.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            data = {
                error: 'invalid_upstream_response',
                error_description: 'Deriv OAuth token endpoint returned a non-JSON response.',
            };
        }

        return json(tokenResponse.status, data, origin);
    } catch (error) {
        console.error('Deriv OAuth token exchange failed', error);
        return json(
            502,
            {
                error: 'oauth_upstream_unavailable',
                error_description: error instanceof Error ? error.message : 'Unable to reach Deriv OAuth.',
            },
            origin
        );
    }
};
