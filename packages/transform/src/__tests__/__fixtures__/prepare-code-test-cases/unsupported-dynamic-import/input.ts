// *

const random = Math.random() > 0.5 ? "first" : "second";

export function foo(onImport) {
  import(random).then(onImport);
}
