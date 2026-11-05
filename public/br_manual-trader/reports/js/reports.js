/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(function webpackUniversalModuleDefinition(root, factory) {
	if(typeof exports === 'object' && typeof module === 'object')
		module.exports = factory(require("@deriv-com/analytics"), require("@deriv/components"), require("@deriv/shared"), require("@deriv/translations"), require("mobx"), require("react"), require("react-dom"), require("react-router"), require("react-router-dom"));
	else if(typeof define === 'function' && define.amd)
		define(["@deriv-com/analytics", "@deriv/components", "@deriv/shared", "@deriv/translations", "mobx", "react", "react-dom", "react-router", "react-router-dom"], factory);
	else if(typeof exports === 'object')
		exports["@deriv/reports"] = factory(require("@deriv-com/analytics"), require("@deriv/components"), require("@deriv/shared"), require("@deriv/translations"), require("mobx"), require("react"), require("react-dom"), require("react-router"), require("react-router-dom"));
	else
		root["@deriv/reports"] = factory(root["@deriv-com/analytics"], root["@deriv/components"], root["@deriv/shared"], root["@deriv/translations"], root["mobx"], root["react"], root["react-dom"], root["react-router"], root["react-router-dom"]);
})(self, (__WEBPACK_EXTERNAL_MODULE__deriv_com_analytics__, __WEBPACK_EXTERNAL_MODULE__deriv_components__, __WEBPACK_EXTERNAL_MODULE__deriv_shared__, __WEBPACK_EXTERNAL_MODULE__deriv_translations__, __WEBPACK_EXTERNAL_MODULE_mobx__, __WEBPACK_EXTERNAL_MODULE_react__, __WEBPACK_EXTERNAL_MODULE_react_dom__, __WEBPACK_EXTERNAL_MODULE_react_router__, __WEBPACK_EXTERNAL_MODULE_react_router_dom__) => {
return /******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "../../node_modules/promise-polyfill/src/allSettled.js":
/*!*************************************************************!*\
  !*** ../../node_modules/promise-polyfill/src/allSettled.js ***!
  \*************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\nfunction allSettled(arr) {\n  var P = this;\n  return new P(function(resolve, reject) {\n    if (!(arr && typeof arr.length !== 'undefined')) {\n      return reject(\n        new TypeError(\n          typeof arr +\n            ' ' +\n            arr +\n            ' is not iterable(cannot read property Symbol(Symbol.iterator))'\n        )\n      );\n    }\n    var args = Array.prototype.slice.call(arr);\n    if (args.length === 0) return resolve([]);\n    var remaining = args.length;\n\n    function res(i, val) {\n      if (val && (typeof val === 'object' || typeof val === 'function')) {\n        var then = val.then;\n        if (typeof then === 'function') {\n          then.call(\n            val,\n            function(val) {\n              res(i, val);\n            },\n            function(e) {\n              args[i] = { status: 'rejected', reason: e };\n              if (--remaining === 0) {\n                resolve(args);\n              }\n            }\n          );\n          return;\n        }\n      }\n      args[i] = { status: 'fulfilled', value: val };\n      if (--remaining === 0) {\n        resolve(args);\n      }\n    }\n\n    for (var i = 0; i < args.length; i++) {\n      res(i, args[i]);\n    }\n  });\n}\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (allSettled);\n//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///../../node_modules/promise-polyfill/src/allSettled.js\n");

/***/ }),

/***/ "../../node_modules/promise-polyfill/src/any.js":
/*!******************************************************!*\
  !*** ../../node_modules/promise-polyfill/src/any.js ***!
  \******************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/**\n * @constructor\n */\nfunction AggregateError(errors, message) {\n  (this.name = 'AggregateError'), (this.errors = errors);\n  this.message = message || '';\n}\nAggregateError.prototype = Error.prototype;\n\nfunction any(arr) {\n  var P = this;\n  return new P(function(resolve, reject) {\n    if (!(arr && typeof arr.length !== 'undefined')) {\n      return reject(new TypeError('Promise.any accepts an array'));\n    }\n\n    var args = Array.prototype.slice.call(arr);\n    if (args.length === 0) return reject();\n\n    var rejectionReasons = [];\n    for (var i = 0; i < args.length; i++) {\n      try {\n        P.resolve(args[i])\n          .then(resolve)\n          .catch(function(error) {\n            rejectionReasons.push(error);\n            if (rejectionReasons.length === args.length) {\n              reject(\n                new AggregateError(\n                  rejectionReasons,\n                  'All promises were rejected'\n                )\n              );\n            }\n          });\n      } catch (ex) {\n        reject(ex);\n      }\n    }\n  });\n}\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (any);\n//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///../../node_modules/promise-polyfill/src/any.js\n");

/***/ }),

/***/ "../../node_modules/promise-polyfill/src/finally.js":
/*!**********************************************************!*\
  !*** ../../node_modules/promise-polyfill/src/finally.js ***!
  \**********************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/**\n * @this {Promise}\n */\nfunction finallyConstructor(callback) {\n  var constructor = this.constructor;\n  return this.then(\n    function(value) {\n      // @ts-ignore\n      return constructor.resolve(callback()).then(function() {\n        return value;\n      });\n    },\n    function(reason) {\n      // @ts-ignore\n      return constructor.resolve(callback()).then(function() {\n        // @ts-ignore\n        return constructor.reject(reason);\n      });\n    }\n  );\n}\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (finallyConstructor);\n//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///../../node_modules/promise-polyfill/src/finally.js\n");

/***/ }),

/***/ "../../node_modules/promise-polyfill/src/index.js":
/*!********************************************************!*\
  !*** ../../node_modules/promise-polyfill/src/index.js ***!
  \********************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var _finally__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./finally */ \"../../node_modules/promise-polyfill/src/finally.js\");\n/* harmony import */ var _allSettled__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./allSettled */ \"../../node_modules/promise-polyfill/src/allSettled.js\");\n/* harmony import */ var _any__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./any */ \"../../node_modules/promise-polyfill/src/any.js\");\n\n\n\n\n// Store setTimeout reference so promise-polyfill will be unaffected by\n// other code modifying setTimeout (like sinon.useFakeTimers())\nvar setTimeoutFunc = setTimeout;\n\nfunction isArray(x) {\n  return Boolean(x && typeof x.length !== 'undefined');\n}\n\nfunction noop() {}\n\n// Polyfill for Function.prototype.bind\nfunction bind(fn, thisArg) {\n  return function() {\n    fn.apply(thisArg, arguments);\n  };\n}\n\n/**\n * @constructor\n * @param {Function} fn\n */\nfunction Promise(fn) {\n  if (!(this instanceof Promise))\n    throw new TypeError('Promises must be constructed via new');\n  if (typeof fn !== 'function') throw new TypeError('not a function');\n  /** @type {!number} */\n  this._state = 0;\n  /** @type {!boolean} */\n  this._handled = false;\n  /** @type {Promise|undefined} */\n  this._value = undefined;\n  /** @type {!Array<!Function>} */\n  this._deferreds = [];\n\n  doResolve(fn, this);\n}\n\nfunction handle(self, deferred) {\n  while (self._state === 3) {\n    self = self._value;\n  }\n  if (self._state === 0) {\n    self._deferreds.push(deferred);\n    return;\n  }\n  self._handled = true;\n  Promise._immediateFn(function() {\n    var cb = self._state === 1 ? deferred.onFulfilled : deferred.onRejected;\n    if (cb === null) {\n      (self._state === 1 ? resolve : reject)(deferred.promise, self._value);\n      return;\n    }\n    var ret;\n    try {\n      ret = cb(self._value);\n    } catch (e) {\n      reject(deferred.promise, e);\n      return;\n    }\n    resolve(deferred.promise, ret);\n  });\n}\n\nfunction resolve(self, newValue) {\n  try {\n    // Promise Resolution Procedure: https://github.com/promises-aplus/promises-spec#the-promise-resolution-procedure\n    if (newValue === self)\n      throw new TypeError('A promise cannot be resolved with itself.');\n    if (\n      newValue &&\n      (typeof newValue === 'object' || typeof newValue === 'function')\n    ) {\n      var then = newValue.then;\n      if (newValue instanceof Promise) {\n        self._state = 3;\n        self._value = newValue;\n        finale(self);\n        return;\n      } else if (typeof then === 'function') {\n        doResolve(bind(then, newValue), self);\n        return;\n      }\n    }\n    self._state = 1;\n    self._value = newValue;\n    finale(self);\n  } catch (e) {\n    reject(self, e);\n  }\n}\n\nfunction reject(self, newValue) {\n  self._state = 2;\n  self._value = newValue;\n  finale(self);\n}\n\nfunction finale(self) {\n  if (self._state === 2 && self._deferreds.length === 0) {\n    Promise._immediateFn(function() {\n      if (!self._handled) {\n        Promise._unhandledRejectionFn(self._value);\n      }\n    });\n  }\n\n  for (var i = 0, len = self._deferreds.length; i < len; i++) {\n    handle(self, self._deferreds[i]);\n  }\n  self._deferreds = null;\n}\n\n/**\n * @constructor\n */\nfunction Handler(onFulfilled, onRejected, promise) {\n  this.onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : null;\n  this.onRejected = typeof onRejected === 'function' ? onRejected : null;\n  this.promise = promise;\n}\n\n/**\n * Take a potentially misbehaving resolver function and make sure\n * onFulfilled and onRejected are only called once.\n *\n * Makes no guarantees about asynchrony.\n */\nfunction doResolve(fn, self) {\n  var done = false;\n  try {\n    fn(\n      function(value) {\n        if (done) return;\n        done = true;\n        resolve(self, value);\n      },\n      function(reason) {\n        if (done) return;\n        done = true;\n        reject(self, reason);\n      }\n    );\n  } catch (ex) {\n    if (done) return;\n    done = true;\n    reject(self, ex);\n  }\n}\n\nPromise.prototype['catch'] = function(onRejected) {\n  return this.then(null, onRejected);\n};\n\nPromise.prototype.then = function(onFulfilled, onRejected) {\n  // @ts-ignore\n  var prom = new this.constructor(noop);\n\n  handle(this, new Handler(onFulfilled, onRejected, prom));\n  return prom;\n};\n\nPromise.prototype['finally'] = _finally__WEBPACK_IMPORTED_MODULE_0__[\"default\"];\n\nPromise.all = function(arr) {\n  return new Promise(function(resolve, reject) {\n    if (!isArray(arr)) {\n      return reject(new TypeError('Promise.all accepts an array'));\n    }\n\n    var args = Array.prototype.slice.call(arr);\n    if (args.length === 0) return resolve([]);\n    var remaining = args.length;\n\n    function res(i, val) {\n      try {\n        if (val && (typeof val === 'object' || typeof val === 'function')) {\n          var then = val.then;\n          if (typeof then === 'function') {\n            then.call(\n              val,\n              function(val) {\n                res(i, val);\n              },\n              reject\n            );\n            return;\n          }\n        }\n        args[i] = val;\n        if (--remaining === 0) {\n          resolve(args);\n        }\n      } catch (ex) {\n        reject(ex);\n      }\n    }\n\n    for (var i = 0; i < args.length; i++) {\n      res(i, args[i]);\n    }\n  });\n};\n\nPromise.any = _any__WEBPACK_IMPORTED_MODULE_2__[\"default\"];\n\nPromise.allSettled = _allSettled__WEBPACK_IMPORTED_MODULE_1__[\"default\"];\n\nPromise.resolve = function(value) {\n  if (value && typeof value === 'object' && value.constructor === Promise) {\n    return value;\n  }\n\n  return new Promise(function(resolve) {\n    resolve(value);\n  });\n};\n\nPromise.reject = function(value) {\n  return new Promise(function(resolve, reject) {\n    reject(value);\n  });\n};\n\nPromise.race = function(arr) {\n  return new Promise(function(resolve, reject) {\n    if (!isArray(arr)) {\n      return reject(new TypeError('Promise.race accepts an array'));\n    }\n\n    for (var i = 0, len = arr.length; i < len; i++) {\n      Promise.resolve(arr[i]).then(resolve, reject);\n    }\n  });\n};\n\n// Use polyfill for setImmediate for performance gains\nPromise._immediateFn =\n  // @ts-ignore\n  (typeof setImmediate === 'function' &&\n    function(fn) {\n      // @ts-ignore\n      setImmediate(fn);\n    }) ||\n  function(fn) {\n    setTimeoutFunc(fn, 0);\n  };\n\nPromise._unhandledRejectionFn = function _unhandledRejectionFn(err) {\n  if (typeof console !== 'undefined' && console) {\n    console.warn('Possible Unhandled Promise Rejection:', err); // eslint-disable-line no-console\n  }\n};\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (Promise);\n//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///../../node_modules/promise-polyfill/src/index.js\n");

/***/ }),

/***/ "./src/index.tsx":
/*!***********************!*\
  !*** ./src/index.tsx ***!
  \***********************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react */ \"react\");\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(react__WEBPACK_IMPORTED_MODULE_0__);\n/* harmony import */ var _deriv_shared__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! @deriv/shared */ \"@deriv/shared\");\n/* harmony import */ var _deriv_shared__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(_deriv_shared__WEBPACK_IMPORTED_MODULE_1__);\n/* harmony import */ var _deriv_components__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! @deriv/components */ \"@deriv/components\");\n/* harmony import */ var _deriv_components__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(_deriv_components__WEBPACK_IMPORTED_MODULE_2__);\n/* harmony import */ var promise_polyfill__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! promise-polyfill */ \"../../node_modules/promise-polyfill/src/index.js\");\n\n\n\n\nvar App = (0,_deriv_shared__WEBPACK_IMPORTED_MODULE_1__.makeLazyLoader)(function () {\n  return Promise.all(/*! import() | reports-app */[__webpack_require__.e(\"vendors-node_modules_deriv_deriv-api_dist_DerivAPIBasic_js-node_modules_bowser_es5_js-node_mo-30a356\"), __webpack_require__.e(\"reports-app\")]).then(__webpack_require__.bind(__webpack_require__, /*! ./app */ \"./src/app.tsx\"));\n}, function () {\n  return /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0___default().createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_2__.Loading, null);\n})();\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (App);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./src/index.tsx\n");

/***/ }),

/***/ "@deriv-com/analytics":
/*!***************************************!*\
  !*** external "@deriv-com/analytics" ***!
  \***************************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE__deriv_com_analytics__;

/***/ }),

/***/ "@deriv/components":
/*!************************************!*\
  !*** external "@deriv/components" ***!
  \************************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE__deriv_components__;

/***/ }),

/***/ "@deriv/shared":
/*!********************************!*\
  !*** external "@deriv/shared" ***!
  \********************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE__deriv_shared__;

/***/ }),

/***/ "@deriv/translations":
/*!**************************************!*\
  !*** external "@deriv/translations" ***!
  \**************************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE__deriv_translations__;

/***/ }),

/***/ "mobx":
/*!***********************!*\
  !*** external "mobx" ***!
  \***********************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE_mobx__;

/***/ }),

/***/ "react":
/*!************************!*\
  !*** external "react" ***!
  \************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE_react__;

/***/ }),

/***/ "react-dom":
/*!****************************!*\
  !*** external "react-dom" ***!
  \****************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE_react_dom__;

/***/ }),

/***/ "react-router":
/*!*******************************!*\
  !*** external "react-router" ***!
  \*******************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE_react_router__;

/***/ }),

/***/ "react-router-dom":
/*!***********************************!*\
  !*** external "react-router-dom" ***!
  \***********************************/
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_MODULE_react_router_dom__;

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			id: moduleId,
/******/ 			loaded: false,
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = __webpack_modules__;
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	(() => {
/******/ 		// getDefaultExport function for compatibility with non-harmony modules
/******/ 		__webpack_require__.n = (module) => {
/******/ 			var getter = module && module.__esModule ?
/******/ 				() => (module['default']) :
/******/ 				() => (module);
/******/ 			__webpack_require__.d(getter, { a: getter });
/******/ 			return getter;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/ensure chunk */
/******/ 	(() => {
/******/ 		__webpack_require__.f = {};
/******/ 		// This file contains only the entry chunk.
/******/ 		// The chunk loading function for additional chunks
/******/ 		__webpack_require__.e = (chunkId) => {
/******/ 			return Promise.all(Object.keys(__webpack_require__.f).reduce((promises, key) => {
/******/ 				__webpack_require__.f[key](chunkId, promises);
/******/ 				return promises;
/******/ 			}, []));
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/get javascript chunk filename */
/******/ 	(() => {
/******/ 		// This function allow to reference async chunks
/******/ 		__webpack_require__.u = (chunkId) => {
/******/ 			// return url for filenames based on template
/******/ 			return "reports/js/reports." + chunkId + "." + {"404":"33f44adf874bc4f4eb68","vendors-node_modules_deriv_deriv-api_dist_DerivAPIBasic_js-node_modules_bowser_es5_js-node_mo-30a356":"6e76060b8933adb8447f","reports-app":"71abeab454290edb010b","vendors-node_modules_react-content-loader_dist_react-content-loader_es_js-node_modules_react--f6ab84":"7cc55363e4180c27412d","reports-routes":"9ab5b1a425d0f673fa2d","two-month-picker":"82465e86ebc8bf67e37a"}[chunkId] + ".js";
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/get mini-css chunk filename */
/******/ 	(() => {
/******/ 		// This function allow to reference all chunks
/******/ 		__webpack_require__.miniCssF = (chunkId) => {
/******/ 			// return url for filenames based on template
/******/ 			return "reports/css/reports." + chunkId + "." + {"reports-app":"6e424a93a8ca759afd15","reports-routes":"b40b0c170d6ea83ffc06"}[chunkId] + ".css";
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/global */
/******/ 	(() => {
/******/ 		__webpack_require__.g = (function() {
/******/ 			if (typeof globalThis === 'object') return globalThis;
/******/ 			try {
/******/ 				return this || new Function('return this')();
/******/ 			} catch (e) {
/******/ 				if (typeof window === 'object') return window;
/******/ 			}
/******/ 		})();
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/load script */
/******/ 	(() => {
/******/ 		var inProgress = {};
/******/ 		var dataWebpackPrefix = "@deriv/reports:";
/******/ 		// loadScript function to load a script via script tag
/******/ 		__webpack_require__.l = (url, done, key, chunkId) => {
/******/ 			if(inProgress[url]) { inProgress[url].push(done); return; }
/******/ 			var script, needAttach;
/******/ 			if(key !== undefined) {
/******/ 				var scripts = document.getElementsByTagName("script");
/******/ 				for(var i = 0; i < scripts.length; i++) {
/******/ 					var s = scripts[i];
/******/ 					if(s.getAttribute("src") == url || s.getAttribute("data-webpack") == dataWebpackPrefix + key) { script = s; break; }
/******/ 				}
/******/ 			}
/******/ 			if(!script) {
/******/ 				needAttach = true;
/******/ 				script = document.createElement('script');
/******/ 		
/******/ 				script.charset = 'utf-8';
/******/ 				script.timeout = 120;
/******/ 				if (__webpack_require__.nc) {
/******/ 					script.setAttribute("nonce", __webpack_require__.nc);
/******/ 				}
/******/ 				script.setAttribute("data-webpack", dataWebpackPrefix + key);
/******/ 				script.src = url;
/******/ 			}
/******/ 			inProgress[url] = [done];
/******/ 			var onScriptComplete = (prev, event) => {
/******/ 				// avoid mem leaks in IE.
/******/ 				script.onerror = script.onload = null;
/******/ 				clearTimeout(timeout);
/******/ 				var doneFns = inProgress[url];
/******/ 				delete inProgress[url];
/******/ 				script.parentNode && script.parentNode.removeChild(script);
/******/ 				doneFns && doneFns.forEach((fn) => (fn(event)));
/******/ 				if(prev) return prev(event);
/******/ 			}
/******/ 			var timeout = setTimeout(onScriptComplete.bind(null, undefined, { type: 'timeout', target: script }), 120000);
/******/ 			script.onerror = onScriptComplete.bind(null, script.onerror);
/******/ 			script.onload = onScriptComplete.bind(null, script.onload);
/******/ 			needAttach && document.head.appendChild(script);
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/node module decorator */
/******/ 	(() => {
/******/ 		__webpack_require__.nmd = (module) => {
/******/ 			module.paths = [];
/******/ 			if (!module.children) module.children = [];
/******/ 			return module;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/publicPath */
/******/ 	(() => {
/******/ 		__webpack_require__.p = "/br_manual-trader/";
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/css loading */
/******/ 	(() => {
/******/ 		var createStylesheet = (chunkId, fullhref, resolve, reject) => {
/******/ 			var linkTag = document.createElement("link");
/******/ 		
/******/ 			linkTag.rel = "stylesheet";
/******/ 			linkTag.type = "text/css";
/******/ 			var onLinkComplete = (event) => {
/******/ 				// avoid mem leaks.
/******/ 				linkTag.onerror = linkTag.onload = null;
/******/ 				if (event.type === 'load') {
/******/ 					resolve();
/******/ 				} else {
/******/ 					var errorType = event && (event.type === 'load' ? 'missing' : event.type);
/******/ 					var realHref = event && event.target && event.target.href || fullhref;
/******/ 					var err = new Error("Loading CSS chunk " + chunkId + " failed.\n(" + realHref + ")");
/******/ 					err.code = "CSS_CHUNK_LOAD_FAILED";
/******/ 					err.type = errorType;
/******/ 					err.request = realHref;
/******/ 					linkTag.parentNode.removeChild(linkTag)
/******/ 					reject(err);
/******/ 				}
/******/ 			}
/******/ 			linkTag.onerror = linkTag.onload = onLinkComplete;
/******/ 			linkTag.href = fullhref;
/******/ 		
/******/ 			document.head.appendChild(linkTag);
/******/ 			return linkTag;
/******/ 		};
/******/ 		var findStylesheet = (href, fullhref) => {
/******/ 			var existingLinkTags = document.getElementsByTagName("link");
/******/ 			for(var i = 0; i < existingLinkTags.length; i++) {
/******/ 				var tag = existingLinkTags[i];
/******/ 				var dataHref = tag.getAttribute("data-href") || tag.getAttribute("href");
/******/ 				if(tag.rel === "stylesheet" && (dataHref === href || dataHref === fullhref)) return tag;
/******/ 			}
/******/ 			var existingStyleTags = document.getElementsByTagName("style");
/******/ 			for(var i = 0; i < existingStyleTags.length; i++) {
/******/ 				var tag = existingStyleTags[i];
/******/ 				var dataHref = tag.getAttribute("data-href");
/******/ 				if(dataHref === href || dataHref === fullhref) return tag;
/******/ 			}
/******/ 		};
/******/ 		var loadStylesheet = (chunkId) => {
/******/ 			return new Promise((resolve, reject) => {
/******/ 				var href = __webpack_require__.miniCssF(chunkId);
/******/ 				var fullhref = __webpack_require__.p + href;
/******/ 				if(findStylesheet(href, fullhref)) return resolve();
/******/ 				createStylesheet(chunkId, fullhref, resolve, reject);
/******/ 			});
/******/ 		}
/******/ 		// object to store loaded CSS chunks
/******/ 		var installedCssChunks = {
/******/ 			"reports": 0
/******/ 		};
/******/ 		
/******/ 		__webpack_require__.f.miniCss = (chunkId, promises) => {
/******/ 			var cssChunks = {"reports-app":1,"reports-routes":1};
/******/ 			if(installedCssChunks[chunkId]) promises.push(installedCssChunks[chunkId]);
/******/ 			else if(installedCssChunks[chunkId] !== 0 && cssChunks[chunkId]) {
/******/ 				promises.push(installedCssChunks[chunkId] = loadStylesheet(chunkId).then(() => {
/******/ 					installedCssChunks[chunkId] = 0;
/******/ 				}, (e) => {
/******/ 					delete installedCssChunks[chunkId];
/******/ 					throw e;
/******/ 				}));
/******/ 			}
/******/ 		};
/******/ 		
/******/ 		// no hmr
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/jsonp chunk loading */
/******/ 	(() => {
/******/ 		// no baseURI
/******/ 		
/******/ 		// object to store loaded and loading chunks
/******/ 		// undefined = chunk not loaded, null = chunk preloaded/prefetched
/******/ 		// [resolve, reject, Promise] = chunk loading, 0 = chunk loaded
/******/ 		var installedChunks = {
/******/ 			"reports": 0
/******/ 		};
/******/ 		
/******/ 		__webpack_require__.f.j = (chunkId, promises) => {
/******/ 				// JSONP chunk loading for javascript
/******/ 				var installedChunkData = __webpack_require__.o(installedChunks, chunkId) ? installedChunks[chunkId] : undefined;
/******/ 				if(installedChunkData !== 0) { // 0 means "already installed".
/******/ 		
/******/ 					// a Promise means "currently loading".
/******/ 					if(installedChunkData) {
/******/ 						promises.push(installedChunkData[2]);
/******/ 					} else {
/******/ 						if(true) { // all chunks have JS
/******/ 							// setup Promise in chunk cache
/******/ 							var promise = new Promise((resolve, reject) => (installedChunkData = installedChunks[chunkId] = [resolve, reject]));
/******/ 							promises.push(installedChunkData[2] = promise);
/******/ 		
/******/ 							// start chunk loading
/******/ 							var url = __webpack_require__.p + __webpack_require__.u(chunkId);
/******/ 							// create error before stack unwound to get useful stacktrace later
/******/ 							var error = new Error();
/******/ 							var loadingEnded = (event) => {
/******/ 								if(__webpack_require__.o(installedChunks, chunkId)) {
/******/ 									installedChunkData = installedChunks[chunkId];
/******/ 									if(installedChunkData !== 0) installedChunks[chunkId] = undefined;
/******/ 									if(installedChunkData) {
/******/ 										var errorType = event && (event.type === 'load' ? 'missing' : event.type);
/******/ 										var realSrc = event && event.target && event.target.src;
/******/ 										error.message = 'Loading chunk ' + chunkId + ' failed.\n(' + errorType + ': ' + realSrc + ')';
/******/ 										error.name = 'ChunkLoadError';
/******/ 										error.type = errorType;
/******/ 										error.request = realSrc;
/******/ 										installedChunkData[1](error);
/******/ 									}
/******/ 								}
/******/ 							};
/******/ 							__webpack_require__.l(url, loadingEnded, "chunk-" + chunkId, chunkId);
/******/ 						} else installedChunks[chunkId] = 0;
/******/ 					}
/******/ 				}
/******/ 		};
/******/ 		
/******/ 		// no prefetching
/******/ 		
/******/ 		// no preloaded
/******/ 		
/******/ 		// no HMR
/******/ 		
/******/ 		// no HMR manifest
/******/ 		
/******/ 		// no on chunks loaded
/******/ 		
/******/ 		// install a JSONP callback for chunk loading
/******/ 		var webpackJsonpCallback = (parentChunkLoadingFunction, data) => {
/******/ 			var [chunkIds, moreModules, runtime] = data;
/******/ 			// add "moreModules" to the modules object,
/******/ 			// then flag all "chunkIds" as loaded and fire callback
/******/ 			var moduleId, chunkId, i = 0;
/******/ 			if(chunkIds.some((id) => (installedChunks[id] !== 0))) {
/******/ 				for(moduleId in moreModules) {
/******/ 					if(__webpack_require__.o(moreModules, moduleId)) {
/******/ 						__webpack_require__.m[moduleId] = moreModules[moduleId];
/******/ 					}
/******/ 				}
/******/ 				if(runtime) var result = runtime(__webpack_require__);
/******/ 			}
/******/ 			if(parentChunkLoadingFunction) parentChunkLoadingFunction(data);
/******/ 			for(;i < chunkIds.length; i++) {
/******/ 				chunkId = chunkIds[i];
/******/ 				if(__webpack_require__.o(installedChunks, chunkId) && installedChunks[chunkId]) {
/******/ 					installedChunks[chunkId][0]();
/******/ 				}
/******/ 				installedChunks[chunkId] = 0;
/******/ 			}
/******/ 		
/******/ 		}
/******/ 		
/******/ 		var chunkLoadingGlobal = self["webpackChunk_deriv_reports"] = self["webpackChunk_deriv_reports"] || [];
/******/ 		chunkLoadingGlobal.forEach(webpackJsonpCallback.bind(null, 0));
/******/ 		chunkLoadingGlobal.push = webpackJsonpCallback.bind(null, chunkLoadingGlobal.push.bind(chunkLoadingGlobal));
/******/ 	})();
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// module factories are used so entry inlining is disabled
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	var __webpack_exports__ = __webpack_require__("./src/index.tsx");
/******/ 	__webpack_exports__ = __webpack_exports__["default"];
/******/ 	
/******/ 	return __webpack_exports__;
/******/ })()
;
});