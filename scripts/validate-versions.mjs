import { cwd } from 'node:process';
import { join } from 'path';

import { globSync } from 'glob';
import semver from 'semver';

import { getJSON } from './helpers/getJSON.mjs';

const workingDir = cwd();

const rootPkg = getJSON(join(workingDir, 'package.json'));
const globs = getWorkspacePatterns(rootPkg);

const packages = globs
  .flatMap((g) =>
    globSync(join(workingDir, g, 'package.json'))
      .map((pkgPath) => getJSON(pkgPath))
      .filter((pkg) => pkg && pkg.private !== true)
      .map((pkg) => ({ name: pkg.name, version: pkg.version }))
  )
  .filter(({ name, version }) => Boolean(name) && Boolean(version));

const majorMinorKeyByName = new Map();
const invalidVersions = [];

for (const pkg of packages) {
  const parsed = semver.parse(pkg.version);
  if (!parsed) {
    invalidVersions.push(pkg);
    continue;
  }

  majorMinorKeyByName.set(pkg.name, `${parsed.major}.${parsed.minor}`);
}

if (invalidVersions.length > 0) {
  console.error('Found invalid versions in non-private packages:');
  for (const pkg of invalidVersions) {
    console.error(`- ${pkg.name}: ${pkg.version}`);
  }
  process.exit(1);
}

const uniqueMajorMinor = new Set(majorMinorKeyByName.values());
if (uniqueMajorMinor.size > 1) {
  console.error('Found multiple major/minor versions in non-private packages:');

  const packagesByMajorMinor = new Map();
  for (const [name, majorMinor] of majorMinorKeyByName.entries()) {
    const names = packagesByMajorMinor.get(majorMinor) ?? [];
    names.push(name);
    packagesByMajorMinor.set(majorMinor, names);
  }

  for (const [majorMinor, names] of packagesByMajorMinor.entries()) {
    names.sort();
    console.error(`- ${majorMinor}`);
    for (const name of names) {
      console.error(`  - ${name}`);
    }
  }

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
