import { useEffect, useState } from 'react';
import { getCurrentSiteConfig } from '@/config/site-registry';
import { load, save_types } from '@/external/bot-skeleton';
import { ungzip } from 'pako';
import { getTemplateDomain } from '../domain-brand';
import { DownloadIcon } from '../icons';

type DomainBot = {
    id?: string;
    name?: string;
    title?: string;
    file: string;
    asset?: string;
    encoding?: 'gzip-base64';
    description?: string;
    emoji?: string;
    is_premium?: boolean;
    priority?: number;
    guide?: string;
};

const SHARED_BOT_LIBRARY = {
    title: 'Free Bots',
    manifest_url: '/free-bots/bots.json',
    base_url: '/free-bots',
};

const GITHUB_RAW_BOT_LIBRARY = ''; // Apex Sentinel serves its bot library from its own origin only.

const waitForWorkspace = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const workspace = window.Blockly?.derivWorkspace;
        if (workspace) return workspace;
        await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    throw new Error('Bot Builder workspace is not ready. Open Bot Builder and try again.');
};

const joinUrl = (base: string, file: string) =>
    `${base.replace(/\/$/, '')}/${file.split('/').map(segment => encodeURIComponent(segment)).join('/')}`;

const githubRawUrlForLocalPath = (url: string): string => {
    if (!GITHUB_RAW_BOT_LIBRARY) return '';
    if (url === '/free-bots') return GITHUB_RAW_BOT_LIBRARY;
    if (!url.startsWith('/free-bots/')) return '';
    return joinUrl(GITHUB_RAW_BOT_LIBRARY, url.slice('/free-bots/'.length));
};

class FetchFailure extends Error {
    status: number;
    constructor(message: string, status = 0) {
        super(message);
        this.status = status;
    }
}

const isRejectedByServer = (status: number) => status === 401 || status === 403;

const fetchTextWithFallback = async (urls: string[], label: string): Promise<string> => {
    let lastError = '';
    let lastStatus = 0;

    for (const url of Array.from(new Set(urls.filter(Boolean)))) {
        // One quick retry: a request made right after the tab wakes up can fail once before the connection is back.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
                if (response.ok) return await response.text();
                lastError = `HTTP ${response.status}`;
                lastStatus = response.status;
                if (isRejectedByServer(response.status)) break; // retrying the same URL cannot fix a refusal
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                lastStatus = 0;
                await new Promise(resolve => window.setTimeout(resolve, 400));
            }
        }
    }

    throw new FetchFailure(`${label} could not be loaded${lastError ? ` (${lastError})` : ''}.`, lastStatus);
};

const decodeGzipBase64 = (encoded: string): string => {
    const binary = window.atob(encoded.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return ungzip(bytes, { to: 'string' });
};

const manifestUrlsForSite = () => {
    const site = getCurrentSiteConfig();
    const configuredLibrary = site.bot_library;
    const domainManifestUrl = `/free-bots/domains/${encodeURIComponent(site.id)}.json`;
    const configuredManifestUrl = configuredLibrary?.manifest_url;
    const usesManagedDomainManifest = !configuredManifestUrl || configuredManifestUrl === SHARED_BOT_LIBRARY.manifest_url;
    const manifestUrl = usesManagedDomainManifest ? domainManifestUrl : configuredManifestUrl;
    const baseUrl =
        configuredLibrary?.base_url ||
        (configuredManifestUrl && !usesManagedDomainManifest
            ? configuredManifestUrl.replace(/\/[^/]*$/, '')
            : SHARED_BOT_LIBRARY.base_url);
    const manifestFallbacks = [manifestUrl, githubRawUrlForLocalPath(manifestUrl)];

    // Existing sites inherit the shared library until the external bot manager
    // publishes their first domain manifest. An intentionally empty domain
    // manifest is still authoritative and therefore does not fall through.
    if (usesManagedDomainManifest) {
        manifestFallbacks.push(
            SHARED_BOT_LIBRARY.manifest_url,
            githubRawUrlForLocalPath(SHARED_BOT_LIBRARY.manifest_url)
        );
    }
    return { manifestUrl, baseUrl, manifestFallbacks };
};

const parseManifest = (payload: string): DomainBot[] => {
    const manifest = JSON.parse(payload);
    const items = Array.isArray(manifest) ? manifest : Array.isArray(manifest?.bots) ? manifest.bots : [];
    return items
        .filter((item: any) => item && typeof item.file === 'string')
        .map((item: any) => ({ ...item, priority: Number(item.priority ?? 999) }))
        .sort((a: DomainBot, b: DomainBot) => Number(a.priority ?? 999) - Number(b.priority ?? 999));
};

// The last good bot list, kept in memory. A tab left open for a long time can have its later requests refused
// (for example HTTP 401 after the site's access session expires); the list loaded earlier still shows.
const manifestCache = new Map<string, DomainBot[]>();

const loadManifest = async (urls: string[]): Promise<DomainBot[]> => {
    const bots = parseManifest(await fetchTextWithFallback(urls, 'Bot manifest'));
    manifestCache.set(urls.join('|'), bots);
    return bots;
};

// Called once when the app starts so the list is already in memory before the Free Bots tab is opened.
export const prefetchFreeBots = () => {
    try {
        void loadManifest(manifestUrlsForSite().manifestFallbacks).catch(() => undefined);
    } catch {
        // Prefetch is only an optimisation.
    }
};

const FreeBotsPage = ({ openBotBuilder }: { openBotBuilder?: () => void }) => {
    const domain = getTemplateDomain();
    const { manifestUrl, baseUrl, manifestFallbacks } = manifestUrlsForSite();
    const cacheKey = manifestFallbacks.join('|');

    const [bots, setBots] = useState<DomainBot[]>(() => manifestCache.get(cacheKey) ?? []);
    const [loading, setLoading] = useState(() => !manifestCache.has(cacheKey));
    const [busyFile, setBusyFile] = useState('');
    const [error, setError] = useState('');
    const [rejected, setRejected] = useState(false);

    useEffect(() => {
        let alive = true;
        const refresh = async () => {
            const cached = manifestCache.get(cacheKey);
            if (cached) setBots(cached);
            else setLoading(true);
            setError('');
            setRejected(false);
            try {
                const clean = await loadManifest(manifestFallbacks);
                if (alive) setBots(clean);
            } catch (err) {
                // A list that is already on screen stays; only an empty page needs the error.
                if (alive && !manifestCache.has(cacheKey)) {
                    setError(err instanceof Error ? err.message : String(err));
                    setRejected(err instanceof FetchFailure && isRejectedByServer(err.status));
                }
            } finally {
                if (alive) setLoading(false);
            }
        };
        void refresh();
        return () => { alive = false; };
    }, [manifestUrl]);

    const loadBot = async (bot: DomainBot) => {
        if (!openBotBuilder || !baseUrl) return;
        setBusyFile(bot.file);
        setError('');
        setRejected(false);
        try {
            const assetFile = bot.asset || bot.file;
            const isAbsoluteAssetUrl = /^https?:\/\//i.test(assetFile);
            const localAssetUrl = isAbsoluteAssetUrl ? assetFile : joinUrl(baseUrl, assetFile);
            const rawAssetBase = isAbsoluteAssetUrl ? '' : githubRawUrlForLocalPath(baseUrl);
            const payload = await fetchTextWithFallback(
                [localAssetUrl, rawAssetBase ? joinUrl(rawAssetBase, assetFile) : ''],
                bot.name || bot.file
            );
            const xml = bot.encoding === 'gzip-base64' ? decodeGzipBase64(payload) : payload;
            if (!/<xml[\s>]/i.test(xml) && !/<block[\s>]/i.test(xml)) {
                throw new Error(`${bot.file} is not a Blockly XML bot.`);
            }

            openBotBuilder();
            const workspace = await waitForWorkspace();
            await load({
                block_string: xml,
                file_name: bot.file,
                workspace,
                from: save_types.LOCAL,
                drop_event: {},
                strategy_id: null,
                showIncompatibleStrategyDialog: false,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setRejected(err instanceof FetchFailure && isRejectedByServer(err.status));
        } finally {
            setBusyFile('');
        }
    };

    return <div className='prodb-free-bots'>
        {loading && <div className='prodb-live-empty'>Loading bots…</div>}
        {error && (
            <div className='prodb-live-error'>
                {error}
                {rejected && (
                    <>
                        {' '}The site refused the request, which usually means this page was left open too long and its
                        session expired.{' '}
                        <button type='button' onClick={() => window.location.reload()}>Reload the page</button>
                    </>
                )}
            </div>
        )}
        {!loading && !error && bots.length === 0 && <div className='prodb-live-empty'>No free bots are available yet.</div>}

        <div className='prodb-bot-grid prodb-bot-grid--imported'>
            {bots.map(bot => {
                const name = bot.name || bot.title || bot.file.replace(/\.xml$/i, '');
                const tag = bot.is_premium ? 'PREMIUM' : bot.emoji || 'FREE BOT';
                return <article className='prodb-bot-card prodb-bot-card--imported' key={bot.id || bot.file}>
                    <div className='prodb-bot-card__top'><button type='button'>☆</button><span>{tag}</span></div>
                    <small>{domain}</small>
                    <h2>{name}</h2>
                    <p><i>★</i> {bot.description || 'Bot configured for this domain.'}</p>
                    {bot.guide && baseUrl && <a className='prodb-source-guide' href={joinUrl(baseUrl, bot.guide)} target='_blank' rel='noreferrer'>QUICK GUIDE</a>}
                    <button className='prodb-load-bot' disabled={Boolean(busyFile)} onClick={() => loadBot(bot)}>
                        {busyFile === bot.file ? 'LOADING…' : 'LOAD BOT'} <DownloadIcon />
                    </button>
                </article>;
            })}
        </div>
    </div>;
};

export default FreeBotsPage;
