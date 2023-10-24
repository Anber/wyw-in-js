'use strict';

function _objectDestructuringEmpty(obj) {
  if (obj == null) throw new TypeError('Cannot destructure ' + obj);
}
function _extends() {
  _extends = Object.assign
    ? Object.assign.bind()
    : function (target) {
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
var _require = require('unknown-package'),
  fullNamespace = _extends({}, (_objectDestructuringEmpty(_require), _require));
console.log(fullNamespace);
