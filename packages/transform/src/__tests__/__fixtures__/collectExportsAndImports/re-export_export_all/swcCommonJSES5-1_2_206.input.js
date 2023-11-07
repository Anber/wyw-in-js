'use strict';
Object.defineProperty(exports, '__esModule', {
  value: true,
});
_exportStar(require('unknown-package'), exports);
function _exportStar(from, to) {
  Object.keys(from).forEach(function (k) {
    if (k !== 'default' && !Object.prototype.hasOwnProperty.call(to, k))
      Object.defineProperty(to, k, {
        enumerable: true,
        get: function () {
          return from[k];
        },
      });
  });
  return from;
}
