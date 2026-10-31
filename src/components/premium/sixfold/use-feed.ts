import { useSyncExternalStore } from 'react';
import { type FeedSnapshot, type SixfoldFeed, sixfoldFeed } from './feed';

type FeedView = FeedSnapshot & {
    connect: () => void;
    stop: () => void;
    importDigits: (market: string, text: string) => void;
};

/** React view of any Sixfold-style feed. Re-renders at most every ~400 ms while ticks arrive. */
export function useFeedOf(feed: SixfoldFeed): FeedView {
    const snap = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
    return {
        ...snap,
        connect: feed.connect,
        stop: feed.stop,
        importDigits: feed.importDigits,
    };
}

/** React view of the app-wide Sixfold feed. */
export function useFeed(): FeedView {
    return useFeedOf(sixfoldFeed);
}
