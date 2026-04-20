import { FILE_NAME_BY_KEY, REQUIRED_FILENAMES } from './constants';
import type { RequiredFiles } from './state';

export function detectRequiredFiles(files: File[]) {
  const byName = new Map<string, File[]>();
  for (const f of files) {
    const list = byName.get(f.name) ?? [];
    list.push(f);
    byName.set(f.name, list);
  }

  const required: RequiredFiles = {};
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
      required[key] = file;
    }
  }

  return { required, problems };
}
