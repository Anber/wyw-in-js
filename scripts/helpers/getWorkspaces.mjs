import { join } from 'path';

import { globSync } from 'glob';

import { getJSON } from './getJSON.mjs';
import { getYAML } from './getYAML.mjs';

export function getWorkspaces(cwd) {
  const { packages: globs } = getYAML('pnpm-workspace.yaml');
  const packages = globs.flatMap((g) =>
    globSync(join(cwd, g, 'package.json')).map((pkg) => {
      const pkgJson = getJSON(pkg);
      return {
        name: pkgJson.name,
        version: pkgJson.version,
      };
    })
  );

  return packages.reduce((acc, pkg) => {
    acc[pkg.name] = pkg.version;
    return acc;
  }, {});
}
