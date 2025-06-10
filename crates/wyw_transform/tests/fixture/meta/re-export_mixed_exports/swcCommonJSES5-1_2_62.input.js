'use strict';
Object.defineProperty(exports, '__esModule', {
  value: true,
});
var _exportNames = {};
exports.default = void 0;
var _asyncResolveFallback = require('./asyncResolveFallback');
var _collectExportsAndImports = _interopRequireWildcard(
  require('./collectExportsAndImports')
);
var _isUnnecessaryReactCall = _interopRequireDefault(
  require('./isUnnecessaryReactCall')
);
function _interopRequireDefault(obj) {
  return obj && obj.__esModule
    ? obj
    : {
        default: obj,
      };
}
function _interopRequireWildcard(obj) {
  if (obj && obj.__esModule) {
    return obj;
  } else {
    var newObj = {};
    if (obj != null) {
      for (var key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          var desc =
            Object.defineProperty && Object.getOwnPropertyDescriptor
              ? Object.getOwnPropertyDescriptor(obj, key)
              : {};
          if (desc.get || desc.set) {
            Object.defineProperty(newObj, key, desc);
          } else {
            newObj[key] = obj[key];
          }
        }
      }
    }
    newObj.default = obj;
    return newObj;
  }
}
Object.defineProperty(exports, 'syncResolve', {
  enumerable: true,
  get: function () {
    return _asyncResolveFallback.syncResolve;
  },
});
Object.defineProperty(exports, 'isUnnecessaryReactCall', {
  enumerable: true,
  get: function () {
    return _isUnnecessaryReactCall.default;
  },
});
var _default = 123;
exports.default = _default;
Object.keys(_collectExportsAndImports).forEach(function (key) {
  if (key === 'default' || key === '__esModule') return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _collectExportsAndImports[key];
    },
  });
});
