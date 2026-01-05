import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('@wyw-in-js/shared dependencies', () => {
  it('should ship @types/debug for TypeScript consumers', () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgJsonPath = path.join(dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['@types/debug']).toBeTruthy();
    expect(pkg.devDependencies?.['@types/debug']).toBeUndefined();
  });
});
