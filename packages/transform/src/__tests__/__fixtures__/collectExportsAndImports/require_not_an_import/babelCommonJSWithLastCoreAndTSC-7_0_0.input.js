'use strict';

var notModule = (function () {
  var require = function require() {
    return {};
  };
  var _require = require('unknown-package'),
    dep = _require.dep;
  return result;
})();
console.log(notModule);
