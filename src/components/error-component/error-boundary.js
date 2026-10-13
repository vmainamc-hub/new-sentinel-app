import React from 'react';
import PropTypes from 'prop-types';
import { isChunkLoadError } from '@/utils/chunk-retry';
import ErrorComponent from './index';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    componentDidCatch = (error, info) => {
        // Never swallow the reason: without this the page only says "Sorry for the interruption".
        // eslint-disable-next-line no-console
        console.error('[ErrorBoundary] The page crashed:', error, info?.componentStack);
        if (window.TrackJS) window.TrackJS.console.log(this.props.root_store);

        this.setState({
            hasError: true,
            error,
            info,
        });
    };

    render = () => {
        if (!this.state.hasError) return this.props.children;
        // A file of this page could not be loaded (a new version was published while this tab stayed open, or the host
        // refused the request). A running bot lives outside React and is not affected; reload when it has finished.
        if (isChunkLoadError(this.state.error)) {
            return (
                <ErrorComponent
                    should_show_refresh={true}
                    header='This page needs a reload'
                    message='A part of the page could not be loaded, usually because a newer version was published while this tab was open. A running bot keeps running; reload when it has finished.'
                />
            );
        }
        const detail = this.state.error && this.state.error.message ? String(this.state.error.message).slice(0, 200) : '';
        return <ErrorComponent should_show_refresh={true} message={detail || undefined} />;
    };
}

ErrorBoundary.propTypes = {
    root_store: PropTypes.object,
    children: PropTypes.oneOfType([PropTypes.string, PropTypes.arrayOf(PropTypes.node), PropTypes.node]),
};

export default ErrorBoundary;
