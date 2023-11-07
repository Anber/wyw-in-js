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
  default: () => _default,
  isUnnecessaryReactCall: () => _isUnnecessaryReactCall.default,
  syncResolve: () => _asyncResolveFallback.syncResolve,
});
const _asyncResolveFallback = require('./asyncResolveFallback');
_exportStar(require('./collectExportsAndImports'), exports);
const _isUnnecessaryReactCall = _interopRequireDefault(
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
