import { useEffect } from 'react';
import { getDomainAbbreviation, getTemplateDomain } from './domain-brand';
import './premium-template.scss';

const BrandMark = ({ dark = false }: { dark?: boolean }) => {
    const domain = getTemplateDomain();
    const abbreviation = getDomainAbbreviation(domain);

    useEffect(() => {
        const apply = () => {
            document.title = domain;
            document.documentElement.style.setProperty('--template-domain', `"${domain}"`);
        };
        apply();
        const timer = window.setTimeout(apply, 0);
        return () => {
            window.clearTimeout(timer);
            document.documentElement.style.removeProperty('--template-domain');
        };
    }, [domain]);

    return (
        <div className={`prodb-brand ${dark ? 'prodb-brand--dark' : ''}`} aria-label={domain}>
            <span className='prodb-brand__symbol' aria-hidden='true'>{abbreviation}</span>
            <div className='prodb-brand__copy'>
                <strong>{domain}</strong>
                <small>SMART DERIV TOOLS</small>
            </div>
        </div>
    );
};

export default BrandMark;
