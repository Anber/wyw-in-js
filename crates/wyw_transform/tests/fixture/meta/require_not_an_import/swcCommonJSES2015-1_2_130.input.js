'use strict';
const notModule = (() => {
  const require = () => ({});
  const { dep } = require('unknown-package');
  return result;
})();
console.log(notModule);
