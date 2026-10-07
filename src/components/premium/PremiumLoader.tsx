import BrandMark from './BrandMark';
import { getTemplateDomain } from './domain-brand';

const PremiumLoader = () => {
    const domain = getTemplateDomain();

    return (
        <div className='prodb-loader'>
            <div className='prodb-loader__veil' />
            <div className='prodb-loader__content'>
                <BrandMark dark />
                <h1>{domain}</h1>
                <p>Secure account connection</p>
                <div className='prodb-loader__dots' aria-label='Connecting'><span /><span /><span /></div>
                <small>Please wait while we connect your account...</small>
                <div className='prodb-loader__line'><span /></div>
            </div>
        </div>
    );
};

export default PremiumLoader;
