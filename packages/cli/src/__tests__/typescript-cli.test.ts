import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('CLI TypeScript input', () => {
  it('processes TypeScript files without a Babel config', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-cli-ts-'));

    try {
      const sourceDir = path.join(root, 'src');
      mkdirSync(sourceDir, { recursive: true });

      const entryFile = path.join(sourceDir, 'index.ts');
      writeFileSync(entryFile, 'const a: number = 1;\n', 'utf8');

      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '../wyw-in-js.ts'),
          '--out-dir',
          path.join(root, 'dist'),
          '--source-root',
          root,
          entryFile,
        ],
        {
          encoding: 'utf8',
        }
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Successfully extracted 0 CSS files.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
