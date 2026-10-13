import { Component, type ReactNode } from 'react';
import { Localize } from '@deriv-com/translations';

type Props = { children: ReactNode; label?: string };
type State = { failed: boolean };

/**
 * Keeps a failed lazy-loaded tab (for example Charts or Tutorials, whose files the host refused) from replacing the whole
 * app with the error page. The other tabs, including the Bot Builder, keep working; this one offers a reload.
 */
export default class ChunkErrorBoundary extends Component<Props, State> {
    state: State = { failed: false };

    static getDerivedStateFromError(): State {
        return { failed: true };
    }

    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <div className='chunk-error' role='alert' style={{ padding: '24px', textAlign: 'center' }}>
                <p>
                    <Localize i18n_default_text="This part of the page couldn't be loaded. Check your connection and sign-in, then reload." />
                </p>
                <button type='button' onClick={() => window.location.reload()}>
                    <Localize i18n_default_text='Reload' />
                </button>
            </div>
        );
    }
}
