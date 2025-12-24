// *

export function foo(locale, onImport) {
  import('./foo/' + locale).then(onImport);
  import('./foo/'.concat(locale, '.json')).then(onImport);
}
