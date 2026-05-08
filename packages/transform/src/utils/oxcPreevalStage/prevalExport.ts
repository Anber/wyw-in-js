import { parseSync } from 'oxc-parser';

const parseSourceType = (
  code: string,
  filename: string
): 'module' | 'script' => {
  const parsed = parseSync(filename, code, {
    astType:
      filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js',
    range: true,
    sourceType: 'unambiguous',
  });
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    throw new Error(fatalError.message);
  }

  return parsed.program.sourceType === 'script' ? 'script' : 'module';
};

export const appendOxcWywPreval = (
  code: string,
  filename: string,
  dependencyNames: string[]
): string => {
  const uniqueNames = [...new Set(dependencyNames)];
  const properties = uniqueNames.map((name) => `${name}: ${name}`).join(', ');
  const object = uniqueNames.length > 0 ? `{ ${properties} }` : '{}';

  if (parseSourceType(code, filename) === 'script') {
    return `${code}\nexports.__wywPreval = ${object};`;
  }

  return `${code}\nexport const __wywPreval = ${object};`;
};
