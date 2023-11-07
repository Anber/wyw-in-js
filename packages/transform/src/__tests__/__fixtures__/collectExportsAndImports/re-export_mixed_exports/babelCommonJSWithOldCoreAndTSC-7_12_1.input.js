'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true,
});
var _exportNames = {
  syncResolve: true,
  isUnnecessaryReactCall: true,
};
Object.defineProperty(exports, 'syncResolve', {
  enumerable: true,
  get: function get() {
    return _asyncResolveFallback.syncResolve;
  },
});
Object.defineProperty(exports, 'isUnnecessaryReactCall', {
  enumerable: true,
  get: function get() {
    return _isUnnecessaryReactCall.default;
  },
});
exports.default = void 0;

var _asyncResolveFallback = require('./asyncResolveFallback');

var _collectExportsAndImports = require('./collectExportsAndImports');

Object.keys(_collectExportsAndImports).forEach(function (key) {
  if (key === 'default' || key === '__esModule') return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _collectExportsAndImports[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function get() {
      return _collectExportsAndImports[key];
    },
  });
});

var _isUnnecessaryReactCall = _interopRequireDefault(
  require('./isUnnecessaryReactCall')
);

function _interopRequireDefault(obj) {
  return obj && obj.__esModule ? obj : { default: obj };
}

var _default = 123;
exports.default = _default;
