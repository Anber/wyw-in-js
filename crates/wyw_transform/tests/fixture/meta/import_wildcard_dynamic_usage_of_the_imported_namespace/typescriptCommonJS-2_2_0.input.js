'use strict';
var ns = require('unknown-package');
var key = Math.random() > 0.5 ? 'a' : 'b';
console.log(ns[key]);
