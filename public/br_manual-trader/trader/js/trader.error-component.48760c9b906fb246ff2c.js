"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(self["webpackChunk_deriv_trader"] = self["webpackChunk_deriv_trader"] || []).push([["error-component"],{

/***/ "./src/App/Components/Elements/Errors/error-component.tsx":
/*!****************************************************************!*\
  !*** ./src/App/Components/Elements/Errors/error-component.tsx ***!
  \****************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react */ \"react\");\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(react__WEBPACK_IMPORTED_MODULE_0__);\n/* harmony import */ var _deriv_components__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! @deriv/components */ \"@deriv/components\");\n/* harmony import */ var _deriv_components__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(_deriv_components__WEBPACK_IMPORTED_MODULE_1__);\n/* harmony import */ var _deriv_shared__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! @deriv/shared */ \"@deriv/shared\");\n/* harmony import */ var _deriv_shared__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(_deriv_shared__WEBPACK_IMPORTED_MODULE_2__);\n/* harmony import */ var _deriv_translations__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! @deriv/translations */ \"@deriv/translations\");\n/* harmony import */ var _deriv_translations__WEBPACK_IMPORTED_MODULE_3___default = /*#__PURE__*/__webpack_require__.n(_deriv_translations__WEBPACK_IMPORTED_MODULE_3__);\n\n\n\n\nvar ErrorComponent = function ErrorComponent(_ref) {\n  var header = _ref.header,\n    message = _ref.message,\n    is_dialog = _ref.is_dialog,\n    redirect_label = _ref.redirect_label,\n    redirectOnClick = _ref.redirectOnClick,\n    _ref$should_show_refr = _ref.should_show_refresh,\n    should_show_refresh = _ref$should_show_refr === void 0 ? true : _ref$should_show_refr;\n  var refresh_message = should_show_refresh ? (0,_deriv_translations__WEBPACK_IMPORTED_MODULE_3__.localize)('Please refresh this page to continue.') : '';\n  if (is_dialog) {\n    return /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0___default().createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.Dialog, {\n      title: header || (0,_deriv_translations__WEBPACK_IMPORTED_MODULE_3__.localize)('There was an error'),\n      is_visible: true,\n      confirm_button_text: redirect_label || (0,_deriv_translations__WEBPACK_IMPORTED_MODULE_3__.localize)('Ok'),\n      onConfirm: redirectOnClick || function () {\n        return location.reload();\n      }\n    }, message || (0,_deriv_translations__WEBPACK_IMPORTED_MODULE_3__.localize)('Sorry, an error occurred while processing your request.'));\n  }\n  return /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0___default().createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.PageErrorContainer, {\n    error_header: header !== null && header !== void 0 ? header : '',\n    error_messages: message ? [message, refresh_message] : [],\n    redirect_urls: [_deriv_shared__WEBPACK_IMPORTED_MODULE_2__.routes.trade],\n    redirect_labels: [redirect_label || (0,_deriv_translations__WEBPACK_IMPORTED_MODULE_3__.localize)('Refresh')],\n    buttonOnClick: redirectOnClick || function () {\n      return location.reload();\n    }\n  });\n};\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (ErrorComponent);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./src/App/Components/Elements/Errors/error-component.tsx\n");

/***/ }),

/***/ "./src/App/Components/Elements/Errors/index.ts":
/*!*****************************************************!*\
  !*** ./src/App/Components/Elements/Errors/index.ts ***!
  \*****************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var _error_component__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./error-component */ \"./src/App/Components/Elements/Errors/error-component.tsx\");\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (_error_component__WEBPACK_IMPORTED_MODULE_0__[\"default\"]);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./src/App/Components/Elements/Errors/index.ts\n");

/***/ })

}]);