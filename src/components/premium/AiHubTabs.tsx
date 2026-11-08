import { NAVIGATION_CATALOG } from './site-customization';
import type { PremiumSection } from './types';

const LABELS = Object.fromEntries(NAVIGATION_CATALOG.map(item => [item.id, item.label])) as Partial<Record<PremiumSection, string>>;

// Sub-tab strip shown above a grouped page (AI Hub). It only switches the section through the same handler the top bar uses.
const AiHubTabs = ({
    label,
    members,
    active,
    onChange,
}: {
    label: string;
    members: PremiumSection[];
    active: PremiumSection;
    onChange: (section: PremiumSection) => void;
}) => (
    <div className='prodb-hub-tabs' role='tablist' aria-label={label}>
        {members.map(member => (
            <button
                key={member}
                type='button'
                role='tab'
                aria-selected={active === member}
                className={active === member ? 'is-active' : ''}
                onClick={() => onChange(member)}
            >
                {LABELS[member] ?? member}
            </button>
        ))}
    </div>
);

export default AiHubTabs;
