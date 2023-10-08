import { readFileSync } from 'fs';
import { cwd } from 'node:process';
import { join } from 'path';

import { globSync } from 'glob';
import { parse } from 'yaml';

import { getJSON } from './helpers/getJSON.mjs';

const workingDir = cwd();

const { packages: globs } = parse(readFileSync('pnpm-workspace.yaml', 'utf8'));

const versions = globs.flatMap((g) =>
  globSync(join(workingDir, g, 'package.json')).map(
    (pkg) => getJSON(pkg).version
  )
);
const uniqueVersions = new Set(versions);

if (uniqueVersions.size > 1) {
  console.error('Found multiple versions in packages:');
  console.error(Array.from(uniqueVersions).join('\n'));
  process.exit(1);
}
