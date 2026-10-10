import Purchase from '../Purchase';

const make = () => {
    const Engine = Purchase(class {});
    const engine = new Engine();
    engine.purchaseNow = jest.fn().mockResolvedValue(undefined);
    engine.vhIsVirtualNext = jest.fn().mockReturnValue(false);
    return engine;
};

describe('execution speed and Virtual Hook', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        window.localStorage.clear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('keeps the slow delay for real purchases', async () => {
        window.localStorage.setItem('apex_execution_speed', 'slow');
        const engine = make();
        const purchase = engine.purchase('DIGITOVER');

        expect(engine.purchaseNow).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1999);
        await Promise.resolve();
        expect(engine.purchaseNow).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await purchase;
        expect(engine.purchaseNow).toHaveBeenCalledWith('DIGITOVER');
    });

    it('bypasses the slow delay for virtual purchases', async () => {
        window.localStorage.setItem('apex_execution_speed', 'slow');
        const engine = make();
        engine.vhIsVirtualNext.mockReturnValue(true);

        await engine.purchase('DIGITOVER');

        expect(engine.purchaseNow).toHaveBeenCalledWith('DIGITOVER');
    });

    it('does not delay purchases in fast mode', async () => {
        window.localStorage.setItem('apex_execution_speed', 'fast');
        const engine = make();

        await engine.purchase('DIGITOVER');

        expect(engine.purchaseNow).toHaveBeenCalledWith('DIGITOVER');
    });
});
