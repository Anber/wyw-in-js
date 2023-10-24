'use strict';
Object.defineProperty(exports, '__esModule', {
  value: true,
});
function _export(target, all) {
  for (var name in all)
    Object.defineProperty(target, name, {
      get: all[name],
      enumerable: true,
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
var obj = {
  a: 1,
  b: 2,
};
var a = obj.a,
  b = obj.b;
