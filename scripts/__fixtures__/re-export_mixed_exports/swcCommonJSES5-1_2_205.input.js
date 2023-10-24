'use strict';
Object.defineProperty(exports, '__esModule', {
  value: true,
});
Object.defineProperty(exports, 'syncResolve', {
  enumerable: true,
  get: function () {
    return _asyncResolveFallback.syncResolve;
  },
});
var _exportNames = {
  syncResolve: true,
  isUnnecessaryReactCall: true,
};
Object.defineProperty(exports, 'isUnnecessaryReactCall', {
  enumerable: true,
  get: function () {
    return _isUnnecessaryReactCall.default;
  },
});
exports.default = void 0;
var _asyncResolveFallback = require('./asyncResolveFallback');
var _collectExportsAndImports = _interopRequireWildcard(
  require('./collectExportsAndImports')
);
Object.keys(_collectExportsAndImports).forEach(function (key) {
  if (key === 'default' || key === '__esModule') return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _collectExportsAndImports[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _collectExportsAndImports[key];
    },
  });
});
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
function _getRequireWildcardCache() {
  if (typeof WeakMap !== 'function') return null;
  var cache = new WeakMap();
  _getRequireWildcardCache = function () {
    return cache;
  };
  return cache;
}
function _interopRequireWildcard(obj) {
  if (obj && obj.__esModule) {
    return obj;
  }
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return {
      default: obj,
    };
  }
  var cache = _getRequireWildcardCache();
  if (cache && cache.has(obj)) {
    return cache.get(obj);
  }
  var newObj = {};
  var hasPropertyDescriptor =
    Object.defineProperty && Object.getOwnPropertyDescriptor;
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      var desc = hasPropertyDescriptor
        ? Object.getOwnPropertyDescriptor(obj, key)
        : null;
      if (desc && (desc.get || desc.set)) {
        Object.defineProperty(newObj, key, desc);
      } else {
        newObj[key] = obj[key];
      }
    }
  }
  newObj.default = obj;
  if (cache) {
    cache.set(obj, newObj);
  }
  return newObj;
}
var _default = 123;
exports.default = _default;
