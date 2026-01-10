import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

import { globSync } from 'glob';

import { getJSON } from './helpers/getJSON.mjs';

const workingDir = cwd();

const rootPkg = getJSON(join(workingDir, 'package.json'));
const workspacePatterns = getWorkspacePatterns(rootPkg);
const packageJsonPaths = workspacePatterns.flatMap((pattern) =>
  globSync(join(workingDir, pattern, 'package.json'))
);

const packages = packageJsonPaths.map((packageJsonPath) => ({
  packageJsonPath,
  pkgJson: getJSON(packageJsonPath),
}));

const versionByName = new Map(
  packages
    .map(({ pkgJson }) => [pkgJson?.name, pkgJson?.version])
    .filter(([name, version]) => Boolean(name) && Boolean(version))
);

const publishDependencyFields = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
];

let touched = 0;
let updated = 0;

for (const pkg of packages) {
  if (pkg.pkgJson?.private === true) {
    continue;
  }

  touched += 1;

  const { pkgJson } = pkg;
  const { name: packageName } = pkgJson;

  let changed = false;

  for (const field of publishDependencyFields) {
    const deps = pkgJson[field];
    if (!deps) {
      continue;
    }

    for (const [depName, depRange] of Object.entries(deps)) {
      if (typeof depRange !== 'string' || !depRange.startsWith('workspace:')) {
        continue;
      }

      const resolved = resolveWorkspaceProtocol(depName, depRange, versionByName);
      if (resolved !== depRange) {
        deps[depName] = resolved;
        changed = true;
      }
    }
  }

  if (!changed) {
    continue;
  }

  writeFileSync(pkg.packageJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  updated += 1;

  const unresolved = findWorkspaceProtocolRanges(pkgJson, publishDependencyFields);
  if (unresolved.length > 0) {
    throw new Error(
      [
        `Failed to resolve workspace protocol in ${pkg.packageJsonPath} (${packageName}):`,
        ...unresolved.map(
          ({ field, depName, depRange }) => `- ${field}.${depName} = ${depRange}`
        ),
      ].join('\n')
    );
  }
}

if (touched === 0) {
  console.log('No publishable packages found.');
} else if (updated === 0) {
  console.log('No workspace protocol ranges to resolve.');
} else {
  console.log(`Resolved workspace protocol ranges in ${updated} package.json files.`);
}

function resolveWorkspaceProtocol(depName, depRange, versions) {
  const workspaceSpec = depRange.slice('workspace:'.length).trim();

  if (workspaceSpec === '' || workspaceSpec === '*') {
    return resolveWorkspaceVersion(depName, versions);
  }

  if (workspaceSpec === '^') {
    return `^${resolveWorkspaceVersion(depName, versions)}`;
  }

  if (workspaceSpec === '~') {
    return `~${resolveWorkspaceVersion(depName, versions)}`;
  }

  return workspaceSpec;
}

function resolveWorkspaceVersion(depName, versions) {
  const version = versions.get(depName);
  if (!version) {
    throw new Error(
      `Cannot resolve workspace version for ${depName} (dependency range uses workspace protocol).`
    );
  }

  return version;
}

function findWorkspaceProtocolRanges(pkgJson, fields) {
  const results = [];

  for (const field of fields) {
    const deps = pkgJson[field];
    if (!deps) {
      continue;
    }

    for (const [depName, depRange] of Object.entries(deps)) {
      if (typeof depRange === 'string' && depRange.startsWith('workspace:')) {
        results.push({ field, depName, depRange });
      }
    }
  }

  return results;
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

