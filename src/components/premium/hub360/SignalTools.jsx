import { useState } from 'react';
import AiScan from './AiScan';
import Dualbot from './Dualbot';
import EliteFlow from './EliteFlow';
import Higherlower from './Higherlower';
import Oracle from './Oracle';

const TABS = [
    { id: 'aiscan', label: 'AI Scan', Component: AiScan },
    { id: 'oracle', label: 'Oracle Tool', Component: Oracle },
    { id: 'over5under4', label: 'Over5/Under4', Component: Dualbot },
    { id: 'elite', label: 'Elite Flow', Component: EliteFlow },
    { id: 'updown', label: 'Higher/Lower', Component: Higherlower },
];

// Signal Tools: one sub-tab per engine. A sub-tab is mounted the first time it is opened and then only hidden, so a
// running engine is not stopped by looking at another one.
const SignalTools = () => {
    const [active, setActive] = useState(TABS[0].id);
    const [opened, setOpened] = useState([TABS[0].id]);

    const open = id => {
        setActive(id);
        setOpened(prev => (prev.includes(id) ? prev : [...prev, id]));
    };

    return (
        <div className='hub360-signals'>
            <div className='hub360-signals__tabs' role='tablist' aria-label='Signal Tools'>
                {TABS.map(tab => (
                    <button
                        key={tab.id}
                        type='button'
                        role='tab'
                        aria-selected={active === tab.id}
                        className={active === tab.id ? 'is-active' : ''}
                        onClick={() => open(tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className='hub360-signals__view'>
                {TABS.filter(tab => opened.includes(tab.id)).map(({ id, Component }) => (
                    <div key={id} style={{ display: active === id ? 'block' : 'none' }}>
                        <Component />
                    </div>
                ))}
            </div>
        </div>
    );
};

export default SignalTools;
