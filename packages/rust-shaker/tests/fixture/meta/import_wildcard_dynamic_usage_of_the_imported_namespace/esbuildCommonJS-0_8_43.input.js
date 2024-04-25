var __create = Object.create;
var __defProp = Object.defineProperty;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __markAsModule = (target) =>
  __defProp(target, '__esModule', { value: true });
var __exportStar = (target, module2, desc) => {
  if (
    (module2 && typeof module2 === 'object') ||
    typeof module2 === 'function'
  ) {
    for (let key2 of __getOwnPropNames(module2))
      if (!__hasOwnProp.call(target, key2) && key2 !== 'default')
        __defProp(target, key2, {
          get: () => module2[key2],
          enumerable:
            !(desc = __getOwnPropDesc(module2, key2)) || desc.enumerable,
        });
  }
  return target;
};
var __toModule = (module2) => {
  if (module2 && module2.__esModule) return module2;
  return __exportStar(
    __markAsModule(
      __defProp(
        module2 != null ? __create(__getProtoOf(module2)) : {},
        'default',
        { value: module2, enumerable: true }
      )
    ),
    module2
  );
};
var ns = __toModule(require('unknown-package'));
const key = Math.random() > 0.5 ? 'a' : 'b';
console.log(ns[key]);
