'use strict';
function _extends() {
  _extends =
    Object.assign ||
    function (target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        for (var key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) {
            target[key] = source[key];
          }
        }
      }
      return target;
    };
  return _extends.apply(this, arguments);
}
function _object_destructuring_empty(o) {
  if (o === null || o === void 0)
    throw new TypeError('Cannot destructure ' + o);
  return o;
}
var fullNamespace = _extends(
  {},
  _object_destructuring_empty(require('unknown-package'))
);
console.log(fullNamespace);
