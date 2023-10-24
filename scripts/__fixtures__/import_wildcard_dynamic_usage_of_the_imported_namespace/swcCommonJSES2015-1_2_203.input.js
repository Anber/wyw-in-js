'use strict';
var ns = _interopRequireWildcard(require('unknown-package'));
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
  for (var key1 in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key1)) {
      var desc = hasPropertyDescriptor
        ? Object.getOwnPropertyDescriptor(obj, key1)
        : null;
      if (desc && (desc.get || desc.set)) {
        Object.defineProperty(newObj, key1, desc);
      } else {
        newObj[key1] = obj[key1];
      }
    }
  }
  newObj.default = obj;
  if (cache) {
    cache.set(obj, newObj);
  }
  return newObj;
}
const key = Math.random() > 0.5 ? 'a' : 'b';
console.log(ns[key]);
