import path from 'path';

import { createMetadataFile, resolveMetadataFilename } from '../metadata';

describe('CLI metadata helpers', () => {
  it('resolves metadata filenames next to CSS output', () => {
    expect(resolveMetadataFilename('/tmp/out/components/button.css')).toBe(
      '/tmp/out/components/button.wyw-in-js.json'
    );
  });

  it('creates portable metadata manifests', () => {
    const cwd = path.join(path.sep, 'repo');
    const sourceFilename = path.join(cwd, 'src', 'button.tsx');
    const outputFilename = path.join(cwd, 'dist', 'button.css');

    const result = createMetadataFile({
      cssFile: outputFilename,
      metadata: {
        dependencies: ['src/theme.ts'],
        processors: [
          {
            artifacts: [['meta', { className: 'button_root' }]],
            className: 'button_root',
            displayName: 'button',
            start: { column: 2, line: 5 },
          },
        ],
        replacements: [],
        rules: {
          '.button_root': {
            className: 'button_root',
            cssText: 'color:red;',
            displayName: 'button',
            start: { column: 2, line: 5 },
          },
        },
      },
      outputRoot: path.join(cwd, 'dist'),
      outputFilename,
      sourceRoot: cwd,
      sourceFilename,
    });

    expect(result.filename).toBe(
      path.join(cwd, 'dist', 'button.wyw-in-js.json')
    );
    expect(result.content).toContain('"version": 1');
    expect(result.content).toContain('"source": "src/button.tsx"');
    expect(result.content).toContain('"cssFile": "button.css"');
    expect(result.content).toContain('"className": "button_root"');
  });
});
