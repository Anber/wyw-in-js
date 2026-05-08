import {
  FILE_NAME_BY_KEY,
  OPTIONAL_FILENAMES,
  REQUIRED_FILENAMES,
} from './constants';
import type { SelectedFiles } from './state';

export function detectRequiredFiles(files: File[]) {
  const byName = new Map<string, File[]>();
  for (const f of files) {
    const list = byName.get(f.name) ?? [];
    list.push(f);
    byName.set(f.name, list);
  }

  const selected: SelectedFiles = {};
  const problems: string[] = [];

  for (const key of REQUIRED_FILENAMES) {
    const expected = FILE_NAME_BY_KEY[key];
    const matches = byName.get(expected) ?? [];

    if (matches.length === 0) {
      problems.push(`Missing ${expected}`);
    } else if (matches.length > 1) {
      problems.push(
        `Multiple files named ${expected} found (${matches.length}). Upload exactly one run.`
      );
    } else {
      const [file] = matches;
      selected[key] = file;
    }
  }

  for (const key of OPTIONAL_FILENAMES) {
    const expected = FILE_NAME_BY_KEY[key];
    const matches = byName.get(expected) ?? [];

    if (matches.length > 1) {
      problems.push(
        `Multiple files named ${expected} found (${matches.length}). Upload exactly one run.`
      );
    } else if (matches.length === 1) {
      const [file] = matches;
      selected[key] = file;
    }
  }

  return { selected, problems };
}
