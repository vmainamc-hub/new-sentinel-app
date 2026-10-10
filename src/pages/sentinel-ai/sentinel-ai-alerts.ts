// SENTINEL AI — signal alerts WITHOUT sound.
//
// Replaces the Forge's audible beep with: an on-screen flash (rendered by the page / global toast),
// a vibration pattern on phones, a system notification, and a flashing browser-tab title.
import type { SentinelAiSettings, SentinelAiSignal } from './sentinel-ai-types';

let titleTimer: number | null = null;
let originalTitle: string | null = null;

const stopTitleFlash = () => {
    if (titleTimer !== null) {
        window.clearInterval(titleTimer);
        titleTimer = null;
    }
    if (originalTitle !== null) {
        document.title = originalTitle;
        originalTitle = null;
    }
};

const flashTitle = (text: string) => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (!document.hidden) return; // Only worth flashing when the tab is in the background.
    stopTitleFlash();
    originalTitle = document.title;
    let on = false;
    titleTimer = window.setInterval(() => {
        on = !on;
        document.title = on ? text : (originalTitle ?? '');
    }, 900);
    const restore = () => {
        if (document.hidden) return;
        stopTitleFlash();
        document.removeEventListener('visibilitychange', restore);
    };
    document.addEventListener('visibilitychange', restore);
    window.setTimeout(() => {
        stopTitleFlash();
        document.removeEventListener('visibilitychange', restore);
    }, 20000);
};

export const describeSignal = (signal: SentinelAiSignal) =>
    `${signal.label} · ${signal.marketName} · enter on ${signal.entryDigit ?? 'WAIT'}`;

export const getNotificationPermission = (): NotificationPermission | 'unsupported' =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

export const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') return 'unsupported' as const;
    try {
        return await Notification.requestPermission();
    } catch {
        return Notification.permission;
    }
};

/** Fires every enabled non-audio alert for a new signal. Never throws. */
export const fireSignalAlerts = (signal: SentinelAiSignal, settings: SentinelAiSettings) => {
    try {
        // Browsers refuse (and log an error for) vibration until the page has had a tap or click.
        const userActivation = (typeof navigator !== 'undefined' ? navigator : undefined) as
            | (Navigator & { userActivation?: { hasBeenActive?: boolean } })
            | undefined;
        if (
            settings.alertVibrate &&
            userActivation &&
            typeof userActivation.vibrate === 'function' &&
            userActivation.userActivation?.hasBeenActive !== false
        ) {
            userActivation.vibrate([180, 80, 180, 80, 320]);
        }
    } catch {
        // Vibration is best effort.
    }

    try {
        if (settings.alertTitle) flashTitle(`● SIGNAL ${signal.label} @ ${signal.entryDigit ?? '?'}`);
    } catch {
        // Title flashing is best effort.
    }

    try {
        if (
            settings.alertNotify &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            typeof document !== 'undefined' &&
            document.hidden
        ) {
            const notification = new Notification('Sentinel AI signal', {
                body: describeSignal(signal),
                tag: 'sentinel-ai-signal',
                requireInteraction: false,
            });
            window.setTimeout(() => notification.close(), 8000);
        }
    } catch {
        // Notifications are best effort.
    }
};
