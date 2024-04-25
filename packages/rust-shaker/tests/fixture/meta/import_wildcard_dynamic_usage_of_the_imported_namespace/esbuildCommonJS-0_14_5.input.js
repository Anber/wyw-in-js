var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __markAsModule = (target) =>
  __defProp(target, '__esModule', { value: true });
var __reExport = (target, module2, copyDefault, desc) => {
  if (
    (module2 && typeof module2 === 'object') ||
    typeof module2 === 'function'
  ) {
    for (let key2 of __getOwnPropNames(module2))
      if (
        !__hasOwnProp.call(target, key2) &&
        (copyDefault || key2 !== 'default')
      )
        __defProp(target, key2, {
          get: () => module2[key2],
          enumerable:
            !(desc = __getOwnPropDesc(module2, key2)) || desc.enumerable,
        });
  }
  return target;
};
var __toESM = (module2, isNodeMode) => {
  return __reExport(
    __markAsModule(
      __defProp(
        module2 != null ? __create(__getProtoOf(module2)) : {},
        'default',
        !isNodeMode && module2 && module2.__esModule
          ? { get: () => module2.default, enumerable: true }
          : { value: module2, enumerable: true }
      )
    ),
    module2
  );
};
var ns = __toESM(require('unknown-package'));
const key = Math.random() > 0.5 ? 'a' : 'b';
console.log(ns[key]);
