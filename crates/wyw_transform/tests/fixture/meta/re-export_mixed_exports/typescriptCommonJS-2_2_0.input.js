'use strict';
function __export(m) {
  for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
var asyncResolveFallback_1 = require('./asyncResolveFallback');
exports.syncResolve = asyncResolveFallback_1.syncResolve;
__export(require('./collectExportsAndImports'));
var isUnnecessaryReactCall_1 = require('./isUnnecessaryReactCall');
exports.isUnnecessaryReactCall = isUnnecessaryReactCall_1['default'];
exports.__esModule = true;
exports['default'] = 123;
