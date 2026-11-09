import { useState } from 'react';
import ElitePremium from './ElitePremium';
import ElitePrimeLite from './ElitePrimeLite';

const VARIANTS = [
    { id: 'lite', label: 'Elite Prime', badge: 'LITE', Component: ElitePrimeLite },
    { id: 'pro', label: 'Elite Prime', badge: 'PRO', Component: ElitePremium },
];

// Elite Prime: Lite and Pro are separate engines. A variant is mounted the first time it is opened and then only hidden,
// so a running one keeps trading while you look at the other.
const ElitePrime = () => {
    const [active, setActive] = useState('lite');
    const [opened, setOpened] = useState(['lite']);

    const open = id => {
        setActive(id);
        setOpened(previous => (previous.includes(id) ? previous : [...previous, id]));
    };

    return (
        <div className='hub360-elite'>
            <div className='hub360-elite__tabs' role='tablist' aria-label='Elite Prime'>
                {VARIANTS.map(variant => (
                    <button
                        key={variant.id}
                        type='button'
                        role='tab'
                        aria-selected={active === variant.id}
                        className={active === variant.id ? 'is-active' : ''}
                        onClick={() => open(variant.id)}
                    >
                        {variant.label} <span className={`hub360-elite__badge hub360-elite__badge--${variant.id}`}>{variant.badge}</span>
                    </button>
                ))}
            </div>
            {VARIANTS.filter(variant => opened.includes(variant.id)).map(({ id, Component }) => (
                <div key={id} style={{ display: active === id ? 'block' : 'none' }}>
                    <Component />
                </div>
            ))}
        </div>
    );
};

export default ElitePrime;
