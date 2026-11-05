"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(self["webpackChunk"] = self["webpackChunk"] || []).push([["information-submitted-modal"],{

/***/ "./App/Containers/Modals/information-submitted-modal/index.ts":
/*!********************************************************************!*\
  !*** ./App/Containers/Modals/information-submitted-modal/index.ts ***!
  \********************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var _information_submitted_modal__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./information-submitted-modal */ \"./App/Containers/Modals/information-submitted-modal/information-submitted-modal.tsx\");\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (_information_submitted_modal__WEBPACK_IMPORTED_MODULE_0__[\"default\"]);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./App/Containers/Modals/information-submitted-modal/index.ts\n");

/***/ }),

/***/ "./App/Containers/Modals/information-submitted-modal/information-submitted-modal.tsx":
/*!*******************************************************************************************!*\
  !*** ./App/Containers/Modals/information-submitted-modal/information-submitted-modal.tsx ***!
  \*******************************************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react */ \"../../../node_modules/react/index.js\");\n/* harmony import */ var _deriv_components__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! @deriv/components */ \"../../components/src/index.ts\");\n/* harmony import */ var _deriv_translations__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! @deriv/translations */ \"../../translations/src/index.js\");\n/* harmony import */ var _deriv_stores__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! @deriv/stores */ \"../../stores/src/index.ts\");\n\n\n\n\nvar InformationSubmittedModal = (0,_deriv_stores__WEBPACK_IMPORTED_MODULE_3__.observer)(function () {\n  var _useStore = (0,_deriv_stores__WEBPACK_IMPORTED_MODULE_3__.useStore)(),\n    ui = _useStore.ui;\n  var is_open = ui.is_kyc_information_submitted_modal_open,\n    toggleKycInformationSubmittedModal = ui.toggleKycInformationSubmittedModal;\n  return /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_1__.Dialog, {\n    className: \"information-submitted-modal\",\n    title: (0,_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.localize)('Information updated'),\n    confirm_button_text: (0,_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.localize)('Close'),\n    onConfirm: toggleKycInformationSubmittedModal,\n    is_visible: is_open,\n    dismissable: true,\n    has_close_icon: true,\n    onEscapeButtonCancel: toggleKycInformationSubmittedModal\n  }, /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_0__.createElement(_deriv_translations__WEBPACK_IMPORTED_MODULE_2__.Localize, {\n    i18n_default_text: \"Thank you for submitting your information.\"\n  }));\n});\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (InformationSubmittedModal);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///./App/Containers/Modals/information-submitted-modal/information-submitted-modal.tsx\n");

/***/ })

}]);