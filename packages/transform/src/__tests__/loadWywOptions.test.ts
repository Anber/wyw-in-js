import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { loadWywOptions } from '../transform/helpers/loadWywOptions';

describe('loadWywOptions', () => {
  const initialCwd = process.cwd();

  afterEach(() => {
    process.chdir(initialCwd);
  });

  it('autodiscovers wyw-in-js.config.mjs files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.mjs');

    writeFileSync(
      configFile,
      [
        'export default {',
        '  displayName: true,',
        '  tagResolver(source, tag) {',
        "    return source === 'test-css-processor' && tag === 'css'",
        "      ? './processor.js'",
        '      : null;',
        '  },',
        '};',
        '',
      ].join('\n')
    );

    try {
      process.chdir(root);

      const options = loadWywOptions({});

      expect(options.displayName).toBe(true);
      expect(
        options.tagResolver?.(
          'test-css-processor',
          'css',
          path.join(root, 'entry.js')
        )
      ).toBe('./processor.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads explicit .mjs configFile paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.mjs');

    writeFileSync(
      path.join(root, 'shared.mjs'),
      'export const displayName = true;\n'
    );
    writeFileSync(
      configFile,
      [
        "import { displayName } from './shared.mjs';",
        '',
        'export default {',
        '  displayName,',
        '};',
        '',
      ].join('\n')
    );

    try {
      const options = loadWywOptions({ configFile });

      expect(options.displayName).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws a clear error for .mjs config files with top-level await', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-options-'));
    const configFile = path.join(root, 'wyw-in-js.config.mjs');

    writeFileSync(
      configFile,
      [
        'await Promise.resolve();',
        '',
        'export default {',
        '  displayName: true,',
        '};',
        '',
      ].join('\n')
    );

    try {
      expect(() => loadWywOptions({ configFile })).toThrow(
        'WyW config loading is synchronous, so .mjs config files must not use top-level await'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
