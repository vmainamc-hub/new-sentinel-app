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

const fetchTextWithFallback = async (urls: string[], label: string): Promise<string> => {
    let lastError = '';

    for (const url of Array.from(new Set(urls.filter(Boolean)))) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (response.ok) return response.text();
            lastError = `HTTP ${response.status}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }

    throw new Error(`${label} could not be loaded${lastError ? ` (${lastError})` : ''}.`);
};

const decodeGzipBase64 = (encoded: string): string => {
    const binary = window.atob(encoded.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return ungzip(bytes, { to: 'string' });
};

const FreeBotsPage = ({ openBotBuilder }: { openBotBuilder?: () => void }) => {
    const site = getCurrentSiteConfig();
    const domain = getTemplateDomain();
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

    const [bots, setBots] = useState<DomainBot[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyFile, setBusyFile] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        let alive = true;
        const loadManifest = async () => {
            setLoading(true);
            setError('');
            try {
                const manifestPayload = await fetchTextWithFallback(manifestFallbacks, 'Bot manifest');
                const manifest = JSON.parse(manifestPayload);
                const items = Array.isArray(manifest) ? manifest : Array.isArray(manifest?.bots) ? manifest.bots : [];
                const clean = items
                    .filter((item: any) => item && typeof item.file === 'string')
                    .map((item: any) => ({ ...item, priority: Number(item.priority ?? 999) }))
                    .sort((a: DomainBot, b: DomainBot) => Number(a.priority ?? 999) - Number(b.priority ?? 999));
                if (alive) setBots(clean);
            } catch (err) {
                if (alive) setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (alive) setLoading(false);
            }
        };
        void loadManifest();
        return () => { alive = false; };
    }, [manifestUrl]);

    const loadBot = async (bot: DomainBot) => {
        if (!openBotBuilder || !baseUrl) return;
        setBusyFile(bot.file);
        setError('');
        try {
            const assetFile = bot.asset || bot.file;
            const localAssetUrl = joinUrl(baseUrl, assetFile);
            const rawAssetBase = githubRawUrlForLocalPath(baseUrl);
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
        } finally {
            setBusyFile('');
        }
    };

    return <div className='prodb-free-bots'>
        {loading && <div className='prodb-live-empty'>Loading bots…</div>}
        {error && <div className='prodb-live-error'>{error}</div>}
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
