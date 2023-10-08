import { readFileSync } from 'fs';

import { parse } from 'yaml';

export function getYAML(path) {
  return parse(readFileSync(path, 'utf8'));
}
