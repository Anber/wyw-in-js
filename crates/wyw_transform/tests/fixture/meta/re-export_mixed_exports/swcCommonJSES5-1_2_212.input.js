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
var _asyncResolveFallback = require('./asyncResolveFallback');
_exportStar(require('./collectExportsAndImports'), exports);
var _isUnnecessaryReactCall = /*#__PURE__*/ _interopRequireDefault(
  require('./isUnnecessaryReactCall')
);
function _exportStar(from, to) {
  Object.keys(from).forEach(function (k) {
    if (k !== 'default' && !Object.prototype.hasOwnProperty.call(to, k))
      Object.defineProperty(to, k, {
        enumerable: true,
        get: function () {
          return from[k];
        },
      });
  });
  return from;
}
function _interopRequireDefault(obj) {
  return obj && obj.__esModule
    ? obj
    : {
        default: obj,
      };
}
var _default = 123;
