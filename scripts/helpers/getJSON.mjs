import { readFileSync } from 'fs';

export function getJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
