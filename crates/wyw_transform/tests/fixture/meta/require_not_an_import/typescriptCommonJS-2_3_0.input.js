var notModule = (function () {
  var require = function () {
    return {};
  };
  var dep = require('unknown-package').dep;
  return result;
})();
console.log(notModule);
