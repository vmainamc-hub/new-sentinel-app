"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(self["webpackChunk"] = self["webpackChunk"] || []).push([["url-unavailable-modal"],{

/***/ "./App/Containers/UrlUnavailableModal/url-unavailable-modal.scss":
/*!***********************************************************************!*\
  !*** ./App/Containers/UrlUnavailableModal/url-unavailable-modal.scss ***!
  \***********************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n// extracted by mini-css-extract-plugin\n//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./App/Containers/UrlUnavailableModal/url-unavailable-modal.scss\n");

/***/ }),

/***/ "./App/Containers/UrlUnavailableModal/index.ts":
/*!*****************************************************!*\
  !*** ./App/Containers/UrlUnavailableModal/index.ts ***!
  \*****************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var _url_unavailable_modal__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./url-unavailable-modal */ \"./App/Containers/UrlUnavailableModal/url-unavailable-modal.tsx\");\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (_url_unavailable_modal__WEBPACK_IMPORTED_MODULE_0__[\"default\"]);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./App/Containers/UrlUnavailableModal/index.ts\n");

/***/ }),

/***/ "./App/Containers/UrlUnavailableModal/url-unavailable-modal.tsx":
/*!**********************************************************************!*\
  !*** ./App/Containers/UrlUnavailableModal/url-unavailable-modal.tsx ***!
  \**********************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react */ \"../../../node_modules/react/index.js\");\n/* harmony import */ var _deriv_components__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! @deriv/components */ \"../../components/src/index.ts\");\n/* harmony import */ var _deriv_translations__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! @deriv/translations */ \"../../translations/src/index.js\");\n/* harmony import */ var _deriv_stores__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! @deriv/stores */ \"../../stores/src/index.ts\");\n/* harmony import */ var _url_unavailable_modal_scss__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ./url-unavailable-modal.scss */ \"./App/Containers/UrlUnavailableModal/url-unavailable-modal.scss\");\n\n\n\n\n\nvar UrlUnavailableModal = (0,_deriv_stores__WEBPACK_IMPORTED_MODULE_3__.observer)(function () {\n  var _useStore = (0,_deriv_stores__WEBPACK_IMPORTED_MODULE_3__.useStore)(),\n    ui = _useStore.ui;\n  var isUrlUnavailableModalVisible = ui.isUrlUnavailableModalVisible,\n    toggleUrlUnavailableModal = ui.toggleUrlUnavailableModal,\n    is_mobile = ui.is_mobile;\n  var onConfirm = function onConfirm() {\n    return toggleUrlUnavailableModal(false);\n  };\n  return /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.Modal, {\n    small: true,\n    has_close_icon: false,\n    is_open: isUrlUnavailableModalVisible,\n    title: /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.Localize, {\n      i18n_default_text: \"The URL you requested isn\\u2019t available\"\n    }),\n    toggleModal: onConfirm,\n    className: \"url-unavailable-modal\",\n    should_close_on_click_outside: true,\n    width: is_mobile ? 'calc(100vw - 3.2rem)' : 'auto'\n  }, /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.Modal.Body, null, /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.Localize, {\n    i18n_default_text: \"This could be because:\"\n  }), /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(\"ul\", null, /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.Localize, {\n    i18n_default_text: \"<0>You\\u2019re not logged in, or</0><0>Our services are unavailable in your country.</0>\",\n    components: [/*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.Text, {\n      as: \"li\",\n      line_height: is_mobile ? 'l' : 'xl',\n      size: is_mobile ? 'xxs' : 'xs',\n      key: 0\n    })]\n  })), /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.Localize, {\n    i18n_default_text: \"<0>Explore our website</0> to see what\\u2019s available.\",\n    components: [/*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.StaticUrl, {\n      key: 0,\n      className: \"link\",\n      href: \"/\"\n    })]\n  })), /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.Modal.Footer, null, /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.Button, {\n    has_effect: true,\n    onClick: onConfirm,\n    primary: true,\n    large: true\n  }, /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.Localize, {\n    i18n_default_text: \"OK\"\n  }))));\n});\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (UrlUnavailableModal);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./App/Containers/UrlUnavailableModal/url-unavailable-modal.tsx\n");

/***/ })

}]);