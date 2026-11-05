// Extra colours for the Last Digit circles of the Manual Trader (the stats rings under Over / Under / Even / Odd ...).
//
// The trader already shades the most frequent digit green and the least frequent red. This adds:
//   - 2nd most frequent  -> blue ring
//   - 2nd least frequent -> violet ring
//   - most increasing    -> gold glow around the digit. "Increasing" compares each digit's share now with its share
//                           WINDOW stats updates ago (default 100, set localStorage "digit_trend_window" = 5..900 to change).
//                           It needs a few updates of history first, so it appears after about 10 updates.
// It only reads the percentages the trader already shows and adds CSS classes, so it cannot change any trade. Every step is
// wrapped, so if anything is unexpected it simply does nothing. Tested by scripts/manual-trader/digit-highlights.test.js.
(function () {
    var DEFAULT_WINDOW = 100;
    var MIN_SAMPLES = 10; // updates of history needed before "most increasing" is shown
    var MAX_HISTORY = 1000;
    var MIN_RISE = 0.05; // percentage points; below this nothing counts as rising
    var STYLE_ID = 'manual-trader-digit-highlights-style';

    var CSS =
        '.digits__digit.mt-dg-second-max .progress__value{stroke:#2563eb !important;stroke-opacity:1 !important}' +
        '.digits__digit.mt-dg-second-min .progress__value{stroke:#7c3aed !important;stroke-opacity:1 !important}' +
        '.digits__digit.mt-dg-rising .digits__pie-container{filter:drop-shadow(0 0 3px #eab308) drop-shadow(0 0 6px #eab308)}' +
        '.digits__digit.mt-dg-rising .digits__digit-display-value{color:#b45309 !important;font-weight:700}';

    var TITLES = {
        max: 'Most frequent digit',
        min: 'Least frequent digit',
        second_max: '2nd most frequent digit',
        second_min: '2nd least frequent digit',
        rising: 'Most increasing digit',
    };

    var toNumber = function (value) {
        var n = typeof value === 'number' ? value : parseFloat(value);
        return isNaN(n) ? 0 : n;
    };

    // values: share of each digit 0..9 (percent). past: the same, some updates ago, or null.
    // Returns the digits (arrays) for each group. A digit gets at most one of max / min / second_max / second_min.
    var computeHighlights = function (values, past) {
        var result = { max: [], min: [], second_max: [], second_min: [], rising: [] };
        if (!values || values.length !== 10) return result;
        var nums = values.map(toNumber);
        var distinct = nums
            .filter(function (v, i) {
                return nums.indexOf(v) === i;
            })
            .sort(function (a, b) {
                return b - a;
            });
        if (distinct.length < 2) return result; // no stats yet, or all digits identical
        var max = distinct[0];
        var min = distinct[distinct.length - 1];
        var second_max = distinct.length > 2 ? distinct[1] : null;
        var second_min = distinct.length > 3 ? distinct[distinct.length - 2] : null;
        if (second_min !== null && second_min === second_max) second_min = null;
        nums.forEach(function (v, digit) {
            if (v === max) result.max.push(digit);
            else if (v === min) result.min.push(digit);
            else if (second_max !== null && v === second_max) result.second_max.push(digit);
            else if (second_min !== null && v === second_min) result.second_min.push(digit);
        });
        if (past && past.length === 10) {
            var best = -1;
            var best_delta = MIN_RISE;
            nums.forEach(function (v, digit) {
                var delta = v - toNumber(past[digit]);
                if (delta > best_delta || (delta === best_delta && best >= 0 && v > nums[best])) {
                    best = digit;
                    best_delta = delta;
                }
            });
            if (best >= 0) result.rising.push(best);
        }
        return result;
    };

    var api = { computeHighlights: computeHighlights, MIN_SAMPLES: MIN_SAMPLES, DEFAULT_WINDOW: DEFAULT_WINDOW };
    if (typeof document === 'undefined') {
        if (typeof module !== 'undefined' && module.exports) module.exports = api;
        return;
    }

    var readWindow = function () {
        try {
            var v = parseInt(window.localStorage.getItem('digit_trend_window'), 10);
            if (v >= 5 && v <= 900) return v;
        } catch (e) {
            // storage unavailable
        }
        return DEFAULT_WINDOW;
    };

    var digitElements = function (container) {
        var list = Array.prototype.filter.call(container.children || [], function (child) {
            return child.classList && child.classList.contains('digits__digit');
        });
        return list.length === 10 ? list : null;
    };

    var readValues = function (elements) {
        return elements.map(function (element) {
            var text = element.querySelector('.digits__digit-display-percentage');
            return text ? toNumber(text.textContent) : 0;
        });
    };

    var apply = function (elements, result) {
        var groups = ['max', 'min', 'second_max', 'second_min', 'rising'];
        elements.forEach(function (element, digit) {
            element.classList.remove('mt-dg-second-max', 'mt-dg-second-min', 'mt-dg-rising');
            var titles = [];
            groups.forEach(function (group) {
                if (result[group].indexOf(digit) === -1) return;
                titles.push(TITLES[group]);
                if (group === 'second_max') element.classList.add('mt-dg-second-max');
                if (group === 'second_min') element.classList.add('mt-dg-second-min');
                if (group === 'rising') element.classList.add('mt-dg-rising');
            });
            if (titles.length) element.setAttribute('title', titles.join(', '));
            else if (element.getAttribute('data-mt-dg-title')) element.removeAttribute('title');
            element.setAttribute('data-mt-dg-title', titles.length ? '1' : '');
        });
    };

    var update = function () {
        try {
            var containers = document.querySelectorAll('.digits');
            Array.prototype.forEach.call(containers, function (container) {
                var elements = digitElements(container);
                if (!elements) return;
                var values = readValues(elements);
                var signature = values.join(',');
                var history = container.__mtDigitHistory || (container.__mtDigitHistory = { last: '', samples: [] });
                if (history.last !== signature) {
                    history.last = signature;
                    history.samples.push(values);
                    if (history.samples.length > MAX_HISTORY) history.samples.shift();
                }
                var samples = history.samples;
                var back = Math.min(readWindow(), samples.length - 1);
                var past = back >= MIN_SAMPLES ? samples[samples.length - 1 - back] : null;
                apply(elements, computeHighlights(values, past));
            });
        } catch (e) {
            // never let a display nicety affect the trader
        }
    };

    var start = function () {
        try {
            if (!document.getElementById(STYLE_ID)) {
                var style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = CSS;
                (document.head || document.documentElement).appendChild(style);
            }
            var timer = null;
            var schedule = function () {
                if (timer) return;
                timer = setTimeout(function () {
                    timer = null;
                    update();
                }, 150);
            };
            if (window.MutationObserver && document.body) {
                new MutationObserver(schedule).observe(document.body, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                });
            }
            setInterval(update, 2000);
            update();
        } catch (e) {
            // do nothing
        }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
