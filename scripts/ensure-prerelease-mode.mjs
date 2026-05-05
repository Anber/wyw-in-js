import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, cwd, exit } from 'node:process';

import { getJSON } from './helpers/getJSON.mjs';

const expectedTag = argv[2];

if (!expectedTag) {
  fail('Usage: node ./scripts/ensure-prerelease-mode.mjs <tag>');
}

const preStatePath = join(cwd(), '.changeset', 'pre.json');

if (!existsSync(preStatePath)) {
  fail(
    `Expected Changesets prerelease mode with tag "${expectedTag}", but .changeset/pre.json does not exist.`
  );
}

const preState = getJSON(preStatePath);

if (preState.mode !== 'pre') {
  fail(
    `Expected Changesets prerelease mode with tag "${expectedTag}", but pre mode is "${preState.mode}".`
  );
}

if (preState.tag !== expectedTag) {
  fail(
    `Expected Changesets prerelease tag "${expectedTag}", but found "${preState.tag}".`
  );
}

console.log(`Changesets prerelease mode is active with tag "${expectedTag}".`);

function fail(message) {
  console.error(message);
  exit(1);
}
