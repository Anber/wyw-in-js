import {
  collectOxcExportsAndImports,
  type OxcCollectedState,
} from './collectOxcExportsAndImports';

export const toOxcImportMap = (
  collected: Pick<OxcCollectedState, 'imports' | 'reexports'>
): Map<string, string[]> => {
  const result = new Map<string, string[]>();

  const add = (source: string, imported: string): void => {
    const bucket = result.get(source) ?? [];
    if (!bucket.includes(imported)) {
      bucket.push(imported);
    }

    result.set(source, bucket);
  };

  collected.imports.forEach((item) => {
    add(item.source, item.imported || 'side-effect');
  });
  collected.reexports.forEach((item) => {
    add(item.source, item.imported || 'side-effect');
  });

  return result;
};

export const collectOxcImportMap = (
  code: string,
  filename: string
): Map<string, string[]> =>
  toOxcImportMap(collectOxcExportsAndImports(code, filename));
