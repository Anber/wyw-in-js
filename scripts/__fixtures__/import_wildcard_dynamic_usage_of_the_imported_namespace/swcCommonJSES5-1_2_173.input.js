'use strict';
var ns = _interopRequireWildcard(require('unknown-package'));
function _interopRequireWildcard(obj) {
  if (obj && obj.__esModule) {
    return obj;
  } else {
    var newObj = {};
    if (obj != null) {
      for (var key1 in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key1)) {
          var desc =
            Object.defineProperty && Object.getOwnPropertyDescriptor
              ? Object.getOwnPropertyDescriptor(obj, key1)
              : {};
          if (desc.get || desc.set) {
            Object.defineProperty(newObj, key1, desc);
          } else {
            newObj[key1] = obj[key1];
          }
        }
      }
    }
    newObj.default = obj;
    return newObj;
  }
}
var key = Math.random() > 0.5 ? 'a' : 'b';
console.log(ns[key]);
