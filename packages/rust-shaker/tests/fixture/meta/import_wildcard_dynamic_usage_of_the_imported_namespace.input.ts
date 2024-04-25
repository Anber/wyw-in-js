import * as ns from 'unknown-package';

const key = Math.random() > 0.5 ? 'a' : 'b';

console.log(ns[key]);