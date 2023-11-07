'use strict';
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        Object.defineProperty(o, k2, {
          enumerable: true,
          get: function () {
            return m[k];
          },
        });
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __exportStar =
  (this && this.__exportStar) ||
  function (m, exports) {
    for (var p in m)
      if (p !== 'default' && !Object.prototype.hasOwnProperty.call(exports, p))
        __createBinding(exports, m, p);
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.isUnnecessaryReactCall = exports.syncResolve = void 0;
var asyncResolveFallback_1 = require('./asyncResolveFallback');
Object.defineProperty(exports, 'syncResolve', {
  enumerable: true,
  get: function () {
    return asyncResolveFallback_1.syncResolve;
  },
});
__exportStar(require('./collectExportsAndImports'), exports);
var isUnnecessaryReactCall_1 = require('./isUnnecessaryReactCall');
Object.defineProperty(exports, 'isUnnecessaryReactCall', {
  enumerable: true,
  get: function () {
    return isUnnecessaryReactCall_1.default;
  },
});
exports.default = 123;
