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
  syncResolve: function () {
    return _asyncResolveFallback.syncResolve;
  },
  isUnnecessaryReactCall: function () {
    return _isUnnecessaryReactCall.default;
  },
  default: function () {
    return _default;
  },
});
const _asyncResolveFallback = require('./asyncResolveFallback');
_export_star(require('./collectExportsAndImports'), exports);
const _isUnnecessaryReactCall = /*#__PURE__*/ _interop_require_default(
  require('./isUnnecessaryReactCall')
);
function _export_star(from, to) {
  Object.keys(from).forEach(function (k) {
    if (k !== 'default' && !Object.prototype.hasOwnProperty.call(to, k)) {
      Object.defineProperty(to, k, {
        enumerable: true,
        get: function () {
          return from[k];
        },
      });
    }
  });
  return from;
}
function _interop_require_default(obj) {
  return obj && obj.__esModule
    ? obj
    : {
        default: obj,
      };
}
const _default = 123;
