"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(self["webpackChunk"] = self["webpackChunk"] || []).push([["additional-kyc-info-modal"],{

/***/ "../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.scss":
/*!*********************************************************************************************!*\
  !*** ../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.scss ***!
  \*********************************************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n// extracted by mini-css-extract-plugin\n//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.scss\n");

/***/ }),

/***/ "../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.tsx":
/*!********************************************************************************************!*\
  !*** ../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.tsx ***!
  \********************************************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"AdditionalKycInfoModal\": () => (/* binding */ AdditionalKycInfoModal)\n/* harmony export */ });\n/* harmony import */ var _deriv_components__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! @deriv/components */ \"../../components/src/index.ts\");\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! react */ \"../../../node_modules/react/index.js\");\nfunction _typeof(obj) { \"@babel/helpers - typeof\"; return _typeof = \"function\" == typeof Symbol && \"symbol\" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && \"function\" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? \"symbol\" : typeof obj; }, _typeof(obj); }\n\n\nvar AdditionalKycInfoFormWithHintBox = function AdditionalKycInfoFormWithHintBox(_ref) {\n  var error = _ref.error,\n    setError = _ref.setError;\n  return /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_1__.createElement(react__WEBPACK_IMPORTED_MODULE_1__.Fragment, null, !!error && /*#__PURE__*/react__WEBPACK_IMPORTED_MODULE_1__.createElement(_deriv_components__WEBPACK_IMPORTED_MODULE_0__.InlineMessage, {\n    size: \"sm\",\n    message: error && _typeof(error) === 'object' && 'message' in error && typeof error.message === 'string' && error.message,\n    type: \"error\"\n  }));\n};\nvar AdditionalKycInfoModal = function AdditionalKycInfoModal() {\n  // const {\n  //     ui: { is_additional_kyc_info_modal_open: is_open, toggleAdditionalKycInfoModal },\n  // } = useStore();\n  // const [error, setError] = React.useState<unknown>('');\n\n  // const toggleModal = (e?: React.MouseEvent<HTMLElement, MouseEvent> | undefined) => {\n  //     // if e.target is anchor tag, don't close modal for link click within modal\n  //     const target = e?.target as HTMLElement;\n  //     if (target.tagName === 'A') e?.stopPropagation();\n  //     toggleAdditionalKycInfoModal();\n  // };\n\n  // const mt5_platform_settings = getPlatformSettings('mt5');\n\n  // const ModalTitle = () => (\n  //     <Localize\n  //         i18n_default_text='Additional information required for {{platform}} account(s)'\n  //         values={{\n  //             platform: mt5_platform_settings.name,\n  //         }}\n  //     />\n  // );\n\n  // return (\n  //     <React.Suspense fallback={<UILoader />}>\n  //         <div className='additional-kyc-info-modal__container'>\n  //             <DesktopWrapper>\n  //                 <Modal\n  //                     has_close_icon\n  //                     is_open={is_open}\n  //                     title={<ModalTitle />}\n  //                     toggleModal={toggleModal}\n  //                     className='additional-kyc-info'\n  //                     width='90.4rem'\n  //                     height={error ? '54.4rem' : '49.6rem'}\n  //                 >\n  //                     <Modal.Body className='additional-kyc-info-modal__form'>\n  //                         <AdditionalKycInfoFormWithHintBox setError={setError} error={error} />\n  //                     </Modal.Body>\n  //                 </Modal>\n  //             </DesktopWrapper>\n  //             <MobileWrapper>\n  //                 <PageOverlay\n  //                     is_open\n  //                     portal_id='deriv_app'\n  //                     header={\n  //                         <Text as='p' size='xs' weight='bold'>\n  //                             <ModalTitle />\n  //                         </Text>\n  //                     }\n  //                     onClickClose={toggleAdditionalKycInfoModal}\n  //                     header_classname='additional-kyc-info-modal__portal-header'\n  //                 >\n  //                     <Div100vhContainer className='additional-kyc-info-modal__form' height_offset='100px'>\n  //                         <AdditionalKycInfoFormWithHintBox />\n  //                     </Div100vhContainer>\n  //                 </PageOverlay>\n  //             </MobileWrapper>\n  //         </div>\n  //     </React.Suspense>\n  // );\n};\n\n// AdditionalKycInfoModal.displayName = 'AdditionalKycInfoModal';//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.tsx\n");

/***/ }),

/***/ "../../account/src/Components/additional-kyc-info-modal/index.ts":
/*!***********************************************************************!*\
  !*** ../../account/src/Components/additional-kyc-info-modal/index.ts ***!
  \***********************************************************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (__WEBPACK_DEFAULT_EXPORT__)\n/* harmony export */ });\n/* harmony import */ var _additional_kyc_info_modal__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./additional-kyc-info-modal */ \"../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.tsx\");\n/* harmony import */ var _additional_kyc_info_modal_scss__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./additional-kyc-info-modal.scss */ \"../../account/src/Components/additional-kyc-info-modal/additional-kyc-info-modal.scss\");\n\n\n/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (_additional_kyc_info_modal__WEBPACK_IMPORTED_MODULE_0__.AdditionalKycInfoModal);//# sourceURL=[module]\n\n//# sourceURL=webpack-internal:///../../account/src/Components/additional-kyc-info-modal/index.ts\n");

/***/ })

}]);