const getTicksInterface = tradeEngine => {
    return {
        getDelayTickValue: (...args) => tradeEngine.getDelayTickValue(...args),
        getCurrentStat: (...args) => tradeEngine.getCurrentStat(...args),
        getStatList: (...args) => tradeEngine.getStatList(...args),
        getLastTick: (...args) => tradeEngine.getLastTick(...args),
        getLastDigit: (...args) => tradeEngine.getLastDigit(...args),
        getTicks: (...args) => tradeEngine.getTicks(...args),
        checkDirection: (...args) => tradeEngine.checkDirection(...args),
        getOhlcFromEnd: (...args) => tradeEngine.getOhlcFromEnd(...args),
        getOhlc: (...args) => tradeEngine.getOhlc(...args),
        getLastDigitList: (...args) => tradeEngine.getLastDigitList(...args),
        getDigitFrequencyAnalysis: (...args) => tradeEngine.getDigitFrequencyAnalysis(...args),
        // Analysis Logics helpers
        getLastDigitsCondition: (...args) => tradeEngine.getLastDigitsCondition(...args),
        getDigitFrequency: (...args) => tradeEngine.getDigitFrequency(...args),
        getEvenOddPercent: (...args) => tradeEngine.getEvenOddPercent(...args),
        getOverUnderPercent: (...args) => tradeEngine.getOverUnderPercent(...args),
        getMatchDiffPercent: (...args) => tradeEngine.getMatchDiffPercent(...args),
        getRiseFallPercent: (...args) => tradeEngine.getRiseFallPercent(...args),
    };
};

export default getTicksInterface;
