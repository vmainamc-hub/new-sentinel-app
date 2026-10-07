import { getCurrentSiteConfig } from '@/config/site-registry';
import BrandMark from './BrandMark';
import { BoltIcon, ChevronIcon, PulseIcon } from './icons';
import PremiumTicker from './PremiumTicker';

const reviews = [
    ['EO','Emmanuel Okwonkwo','Binary Options — Lagos, Nigeria','Solid tools for structured trading. The analysis section alone is worth the sign-up.','yellow'],
    ['AK','Akosua Mensah','Volatility Trader — Accra, Ghana','I recommend this to every trader in my community — especially the free bot library.','coral'],
    ['TM','Tendai Moyo','Matches/Differs — Harare, Zimbabwe','Bulk Trader with barrier digits is a game changer. Smooth on mobile too.','purple'],
    ['CP','Chanda Phiri','Over/Under — Lusaka, Zambia','Clear layout, no clutter — I can focus on execution instead of fighting the UI.','mint'],
    ['YB','Yonas Bekele','Synthetic Indices — Addis Ababa, Ethiopia','The hub brings African traders and global Deriv tools together really well.','gold'],
    ['JR','James Reid','Bot Builder — London, UK','Professional-grade Blockly workspace with a landing page that actually explains the product.','slate'],
    ['ML','Maria Lopez','Volatility Trader — Madrid, Spain','I use it daily for back-testing ideas before deploying on my live Deriv account.','pink'],
    ['DW','Daniel Weber','Automation — Berlin, Germany','Clean OAuth login, stable tools, and the Blockly skeleton runs without drama.','gray'],
    ['AN','Amina Ndlovu','Synthetic Indices — Johannesburg, South Africa','I load strategies fast, run them with confidence, and track results in one place.','gold'],
    ['KO','Kevin Omondi','Rise/Fall Trader — Mombasa, Kenya','Finally a platform that understands East African Deriv traders — fast, clear, and reliable.','mint2'],
    ['FN','Fatuma Njeri','Digit Trader — Kisumu, Kenya','The tick stats and digit circles on Bulk Trader save me time every single morning.','pink2'],
    ['BM','Brian Mugisha','Volatility 75 — Kigali, Rwanda','I switched from juggling spreadsheets to running bots here — my workflow is so much cleaner.','sky'],
    ['SA','Sarah Akello','Step Index — Gulu, Uganda','Login is quick, the dashboard loads fast, and I can test strategies before going live.','orange2'],
    ['HM','Hassan Mwangi','Crash/Boom — Arusha, Tanzania','Charts, free bots, and manual trader in one hub — I do not need five tabs open anymore.','cyan2'],
];

interface Props {
    onLogin: () => void;
    onSignup: () => void;
    busy?: boolean;
}

const ReviewCard = ({ item }: { item: string[] }) => (
    <article className='prodb-review-card'>
        <div className='prodb-review-card__head'>
            <span className={`prodb-avatar prodb-avatar--${item[4]}`}>{item[0]}</span>
            <div>
                <strong>{item[1]}</strong>
                <small>{item[2]}</small>
            </div>
        </div>
        <div className='prodb-review-card__stars'>★★★★★</div>
        <p>{item[3]}</p>
    </article>
);

const LandingPage = ({ onLogin, onSignup, busy }: Props) => {
    const site = getCurrentSiteConfig();

    return (
        <div className='prodb-landing'>
            <header className='prodb-landing__header'>
                <BrandMark dark />
                <span className='prodb-landing__domain'>{site.display_domain}</span>
                <div className='prodb-landing__actions'>
                    <button className='prodb-btn prodb-btn--outline-dark' onClick={onLogin} disabled={busy}>Log in</button>
                    <button className='prodb-btn prodb-btn--green' onClick={onSignup} disabled={busy}>Sign up</button>
                </div>
            </header>
            <PremiumTicker />
            <main className='prodb-landing__stage'>
                <div className='prodb-landing__dots' />
                <section className='prodb-hero'>
                    <div className='prodb-hero__pill'>FREE DERIV BOTS, AUTOMATION, AND TRADING TOOLS IN ONE WORKSPACE</div>
                    <h1 aria-label={`Welcome to ${site.display_domain}`} />
                    <p>Structured trading, built for focus. Build, load, and run Deriv bot strategies from a focused workspace<br className='desktop-only' /> made for everyday traders.</p>
                    <div className='prodb-hero__actions'>
                        <button className='prodb-hero__primary' onClick={onLogin} disabled={busy}>
                            <PulseIcon /><span>{busy ? 'Connecting...' : 'Log in and Trade'}</span><ChevronIcon />
                        </button>
                        <button className='prodb-hero__secondary' onClick={onSignup} disabled={busy}>
                            <BoltIcon /><span>Create Free Account</span>
                        </button>
                    </div>
                </section>
                <section className='prodb-reviews'>
                    <h2>What people say</h2>
                    <div className='prodb-reviews__window'>
                        <div className='prodb-reviews__track'>
                            {[0, 1].map(set => (
                                <div className='prodb-reviews__set' key={set} aria-hidden={set === 1}>
                                    {reviews.map((item, index) => <ReviewCard item={item} key={`${set}-${index}`} />)}
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
                <footer className='prodb-landing__footer'>© 2026 PROD B TRADER. All rights reserved.</footer>
            </main>
        </div>
    );
};

export default LandingPage;