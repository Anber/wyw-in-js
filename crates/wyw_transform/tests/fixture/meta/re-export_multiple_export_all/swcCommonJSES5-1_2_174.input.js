'use strict';
Object.defineProperty(exports, '__esModule', {
  value: true,
});
var _exportNames = {};
var _unknownPackage1 = _interopRequireWildcard(require('unknown-package-1'));
Object.keys(_unknownPackage1).forEach(function (key) {
  if (key === 'default' || key === '__esModule') return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _unknownPackage1[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _unknownPackage1[key];
    },
  });
});
var _unknownPackage2 = _interopRequireWildcard(require('unknown-package-2'));
Object.keys(_unknownPackage2).forEach(function (key) {
  if (key === 'default' || key === '__esModule') return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _unknownPackage2[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _unknownPackage2[key];
    },
  });
});
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
