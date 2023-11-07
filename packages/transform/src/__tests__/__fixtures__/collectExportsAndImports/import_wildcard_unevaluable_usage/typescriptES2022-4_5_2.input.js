import * as ns from 'unknown-package';
var getNamed = function (n) {
  return n.name;
};
var named = getNamed(ns);
console.log(named);
