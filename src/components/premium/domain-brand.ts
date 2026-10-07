import { resolveSiteConfig } from '@/config/site-registry';

const cleanDomain = (value: string) =>
    value
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');

/**
 * Visible branding always follows the host the trader is actually visiting.
 * Site configuration is only a server/SSR fallback; it must never make one
 * hosted domain display another site's marketing name.
 */
export const getTemplateDomain = () => {
    const browserHost = typeof window !== 'undefined' ? window.location.hostname : '';
    if (browserHost) {
        const matched = resolveSiteConfig(browserHost);
        if (matched?.display_domain) return matched.display_domain.trim();
        return cleanDomain(browserHost);
    }

    const configured = resolveSiteConfig();
    return cleanDomain(configured?.display_domain || 'Apex Sentinel');
};

export const getDomainAbbreviation = (domain = getTemplateDomain()) => {
    const stem = cleanDomain(domain).split('.')[0] || 'site';
    const chunks = stem.split(/[-_\s]+/).filter(Boolean);

    if (chunks.length > 1) {
        return chunks
            .slice(0, 3)
            .map(chunk => chunk[0])
            .join('')
            .toUpperCase();
    }

    const compact = stem.replace(/[^a-z0-9]/gi, '');
    return (compact.slice(0, 3) || 'SITE').toUpperCase();
};

export const getDomainTitle = () => getTemplateDomain();
