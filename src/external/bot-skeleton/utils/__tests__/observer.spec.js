import Observer from '../observer';

describe('Observer.unregister', () => {
    it('does not throw when the event was already cleared with unregisterAll', () => {
        // Sequence behind "Cannot read properties of undefined (reading 'filter')": a component registers a
        // listener, the Run Panel clears the whole event when a run starts, then the component's cleanup unregisters.
        const o = new Observer();
        const listener = jest.fn();
        o.register('contract.status', listener);
        o.unregisterAll('contract.status');
        expect(() => o.unregister('contract.status', listener)).not.toThrow();
        o.emit('contract.status', {});
        expect(listener).not.toHaveBeenCalled();
    });

    it('does not throw for an event that was never registered', () => {
        expect(() => new Observer().unregister('never.registered', () => {})).not.toThrow();
    });

    it('still removes only the given listener', () => {
        const o = new Observer();
        const a = jest.fn();
        const b = jest.fn();
        o.register('Error', a);
        o.register('Error', b);
        o.unregister('Error', a);
        o.emit('Error', 1);
        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledWith(1);
    });
});
