import * as ns from 'unknown-package';

const getNamed = (n) => n.name;
const named = getNamed(ns);

console.log(named);
