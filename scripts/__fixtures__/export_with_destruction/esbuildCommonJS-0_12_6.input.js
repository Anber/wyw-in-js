var __defProp = Object.defineProperty;
var __markAsModule = (target) =>
  __defProp(target, '__esModule', { value: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
__markAsModule(exports);
__export(exports, {
  a: () => a,
  b: () => b,
});
const obj = { a: 1, b: 2 };
const { a, b } = obj;
