import { config } from '../../../constants/config';
import { observer as globalObserver } from '../../../utils/observer';

const errorMessage = value => {
    if (value instanceof Error && value.message) return value.message;
    if (typeof value === 'string') return value;
    const root = value && typeof value === 'object' ? value : {};
    const nested = root?.error && typeof root.error === 'object' ? root.error : root;
    return nested?.message || root?.message || nested?.code || root?.code || 'Trading request failed.';
};

export const contract = c => globalObserver.emit('bot.contract', c);

export const contractStatus = c => globalObserver.emit('contract.status', c);

export const info = i => globalObserver.emit('bot.info', i);

export const notify = (className, message) =>
    globalObserver.emit('ui.log.notify', { className, message, sound: config().lists.NOTIFICATION_SOUND[0][1] });

export const log = (log_type, extra) => globalObserver.emit('ui.log.success', { log_type, extra });

export const error = message => globalObserver.emit('ui.log.error', errorMessage(message));
