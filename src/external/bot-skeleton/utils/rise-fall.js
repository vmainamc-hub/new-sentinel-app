/**
 * True when a CALL / PUT contract is Rise/Fall, false when it is Higher/Lower. Deriv's newer API can omit the shortcode on a
 * contract update; without it the barrier decides (Higher/Lower always has one).
 */
export const isRiseFall = (contract = {}) => {
    const shortcode = typeof contract?.shortcode === 'string' ? contract.shortcode : '';
    if (shortcode) return /^S0P$/.test(shortcode.split('_').slice(-2)[0]);
    const barrier = contract?.barrier;
    return barrier === undefined || barrier === null || barrier === '';
};
