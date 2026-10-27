import { useSyncExternalStore } from 'react';
import { type FeedSnapshot, sixfoldFeed } from './feed';

/** React view of the app-wide Sixfold feed. Re-renders at most every ~400 ms while ticks arrive. */
export function useFeed(): FeedSnapshot & {
    connect: () => void;
    stop: () => void;
    useDemo: () => void;
    importDigits: (market: string, text: string) => void;
} {
    const snap = useSyncExternalStore(sixfoldFeed.subscribe, sixfoldFeed.getSnapshot, sixfoldFeed.getSnapshot);
    return {
        ...snap,
        connect: sixfoldFeed.connect,
        stop: sixfoldFeed.stop,
        useDemo: sixfoldFeed.useDemo,
        importDigits: sixfoldFeed.importDigits,
    };
}
