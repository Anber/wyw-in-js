'use strict';
Object.defineProperty(exports, '__esModule', {
  value: true,
});
function _export(target, all) {
  for (var name in all)
    Object.defineProperty(target, name, {
      enumerable: true,
      get: all[name],
    });
}
_export(exports, {
  a: function () {
    return a;
  },
  b: function () {
    return b;
  },
});
const obj = {
  a: 1,
  b: 2,
};
const { a, b } = obj;
