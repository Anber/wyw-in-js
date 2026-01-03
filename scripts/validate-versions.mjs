import { cwd } from 'node:process';
import { join } from 'path';

import { globSync } from 'glob';

import { getJSON } from './helpers/getJSON.mjs';

const workingDir = cwd();

const rootPkg = getJSON(join(workingDir, 'package.json'));
const globs = getWorkspacePatterns(rootPkg);

const versions = globs.flatMap((g) =>
  globSync(join(workingDir, g, 'package.json'))
    .map((pkgPath) => getJSON(pkgPath))
    .filter((pkg) => pkg && pkg.private !== true)
    .map((pkg) => pkg.version)
    .filter(Boolean)
);
const uniqueVersions = new Set(versions);

if (uniqueVersions.size > 1) {
  console.error('Found multiple versions in non-private packages:');
  console.error(Array.from(uniqueVersions).join('\n'));
  process.exit(1);
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
