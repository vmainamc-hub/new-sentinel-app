import { lazy, Suspense, useState } from 'react';
import type { ComponentType } from 'react';
import PremiumLoader from '../PremiumLoader';
import type { PremiumSection } from '../types';
import './hub360-scoped.scss';

// Overlord Pro, Elite Prime and Signal Tools trade on their own sockets. Like the original 360 site, a page is mounted
// the first time it is opened and then only hidden, so a running bot keeps trading while you look at another tab.
const PAGES: Partial<Record<PremiumSection, ComponentType>> = {
    overlord: lazy(() => import('./Overlord')),
    elite_prime: lazy(() => import('./ElitePrime')),
    signal_tools: lazy(() => import('./SignalTools')),
};

const Hub360Host = ({ section }: { section: PremiumSection }) => {
    const [opened, setOpened] = useState<PremiumSection[]>(() => (PAGES[section] ? [section] : []));

    // Derive during render so the page mounts in the same pass that selects it.
    if (PAGES[section] && !opened.includes(section)) setOpened(prev => (prev.includes(section) ? prev : [...prev, section]));

    return (
        <>
            {opened.map(id => {
                const Page = PAGES[id];
                if (!Page) return null;
                const isActive = id === section;
                return (
                    <div key={id} className='hub360-pane' data-hub360-pane={id} style={{ display: isActive ? 'block' : 'none' }}>
                        <Suspense fallback={<PremiumLoader />}>
                            <Page />
                        </Suspense>
                    </div>
                );
            })}
        </>
    );
};

export default Hub360Host;
