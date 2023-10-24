'use strict';
var notModule = (function () {
  var require = function () {
    return {};
  };
  var ref = require('unknown-package'),
    dep = ref.dep;
  return result;
})();
console.log(notModule);
