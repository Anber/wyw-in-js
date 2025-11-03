var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __markAsModule = (target) =>
  __defProp(target, '__esModule', { value: true });
var __require =
  typeof require !== 'undefined'
    ? require
    : (x) => {
        throw new Error('Dynamic require of "' + x + '" is not supported');
      };
var __objRest = (source, exclude) => {
  var target = {};
  for (var prop in source)
    if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
      target[prop] = source[prop];
  if (source != null && __getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(source)) {
      if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
        target[prop] = source[prop];
    }
  return target;
};
var __export = (target, all) => {
  __markAsModule(target);
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
__export(exports, {
  _a: () => _a,
  a: () => a,
  rest: () => rest,
});
const obj = { a: 1, b: 2 };
const _a = obj,
  { a } = _a,
  rest = __objRest(_a, ['a']);
