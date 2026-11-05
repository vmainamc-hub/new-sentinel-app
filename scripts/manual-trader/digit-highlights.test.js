// Run with: node scripts/manual-trader/digit-highlights.test.js
// Checks the ranking logic of digit-highlights.js (no browser needed).
const assert = require('node:assert/strict');
const path = require('node:path');

const { computeHighlights } = require(path.join(__dirname, 'digit-highlights.js'));

// distinct shares: 12 (d3) > 11 (d7) > 10 (d0,d1,d2,d4,d5 mixed) ...
{
    const values = [10.5, 9.5, 10.2, 12.0, 9.0, 10.0, 9.8, 11.0, 8.0, 10.0];
    const r = computeHighlights(values, null);
    assert.deepEqual(r.max, [3]);
    assert.deepEqual(r.min, [8]);
    assert.deepEqual(r.second_max, [7]); // 11.0
    assert.deepEqual(r.second_min, [4]); // 9.0
    assert.deepEqual(r.rising, []); // no history yet
}
// ties for second are all shaded; max/min ties are shared
{
    const values = [12, 12, 11, 11, 10, 10, 9, 9, 8, 8];
    const r = computeHighlights(values, null);
    assert.deepEqual(r.max, [0, 1]);
    assert.deepEqual(r.min, [8, 9]);
    assert.deepEqual(r.second_max, [2, 3]);
    assert.deepEqual(r.second_min, [6, 7]);
}
// a digit never gets two rank colours, and few distinct values leave the seconds empty
{
    const two = computeHighlights([12, 8, 12, 8, 12, 8, 12, 8, 12, 8], null);
    assert.deepEqual(two.max, [0, 2, 4, 6, 8]);
    assert.deepEqual(two.min, [1, 3, 5, 7, 9]);
    assert.deepEqual(two.second_max, []);
    assert.deepEqual(two.second_min, []);
    const three = computeHighlights([12, 10, 8, 10, 10, 10, 10, 10, 10, 10], null);
    assert.deepEqual(three.second_max, [1, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(three.second_min, []); // the one distinct middle value is already the 2nd most
}
// no stats / identical stats highlight nothing
{
    for (const values of [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]]) {
        const r = computeHighlights(values, null);
        assert.deepEqual([r.max, r.min, r.second_max, r.second_min, r.rising], [[], [], [], [], []]);
    }
    assert.deepEqual(computeHighlights([1, 2, 3], null).max, []); // wrong length is ignored
}
// most increasing: biggest gain versus the past sample, must be a real rise
{
    const past = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const now = [10.4, 9.6, 10.0, 10.9, 9.2, 10.1, 9.9, 10.3, 9.8, 9.8];
    assert.deepEqual(computeHighlights(now, past).rising, [3]); // +0.9
    const flat = computeHighlights(past, past);
    assert.deepEqual(flat.rising, []);
    const tiny = computeHighlights([10.03, 9.97, 10, 10, 10, 10, 10, 10, 10, 10], past);
    assert.deepEqual(tiny.rising, []); // +0.03 is below the minimum rise
    // equal rises: the digit with the higher current share wins
    const tie = computeHighlights([10.5, 11.5, 9, 9, 9, 9, 9, 9, 9, 9], [10, 11, 9, 9, 9, 9, 9, 9, 9, 9]);
    assert.deepEqual(tie.rising, [1]); // both +0.5, digit 1 has the higher share
}
// text values from the page are accepted
{
    const r = computeHighlights(['10', '9.5', '11', '12', '8', '10', '10', '10', '10', '10'], null);
    assert.deepEqual(r.max, [3]);
    assert.deepEqual(r.min, [4]);
}
console.log('digit-highlights: ok');
