var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === 'object') || typeof from === 'function') {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = (mod) =>
  __copyProps(__defProp({}, '__esModule', { value: true }), mod);
var source_exports = {};
__export(source_exports, {
  E: () => E,
});
module.exports = __toCommonJS(source_exports);
var E = /* @__PURE__ */ ((E2) => {
  E2[(E2['A'] = 0)] = 'A';
  E2[(E2['B'] = 1)] = 'B';
  E2[(E2['C'] = 2)] = 'C';
  return E2;
})(E || {});
