import { join } from 'path';

import { globSync } from 'glob';

import { getJSON } from './getJSON.mjs';

export function getWorkspaces(cwd) {
  const pkgJson = getJSON(join(cwd, 'package.json'));
  const globs = getWorkspacePatterns(pkgJson);

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

function getWorkspacePatterns(pkgJson) {
  if (!pkgJson) return [];

  const { workspaces } = pkgJson;
  if (Array.isArray(workspaces)) return workspaces;
  if (workspaces && Array.isArray(workspaces.packages)) {
    return workspaces.packages;
  }

  return [];
}
