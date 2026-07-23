import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

const runtimeStyledProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-runtime-styled-processor.js'
);

const resolveImport = async (what: string, importer: string) => {
  if (what === 'test-runtime-styled-processor') {
    return runtimeStyledProcessorFile;
  }

  if (what.startsWith('.')) {
    return resolve(dirname(importer), what);
  }

  return null;
};

const runTransform = (root: string, filename: string) =>
  transform(
    {
      cache: new TransformCacheCollection(),
      options: {
        filename,
        root,
        pluginOptions: {
          configFile: false,
          tagResolver(source, tag) {
            if (
              source === 'test-runtime-styled-processor' &&
              tag === 'styled'
            ) {
              return runtimeStyledProcessorFile;
            }

            return null;
          },
        },
      },
    },
    readFileSync(filename, 'utf8'),
    resolveImport
  );

describe('helper declaration anchoring', () => {
  it('anchors runtime helper declarations outside object and array expressions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-helper-anchoring-'));
    const filename = join(root, 'entry.js');

    writeFileSync(
      filename,
      [
        "import { styled } from 'test-runtime-styled-processor';",
        '',
        "const Button = () => 'button';",
        "const Vertical = () => 'vertical';",
        '',
        'export const HomeStyles = {',
        '  PageTitle: styled("h1")`color: red;`,',
        '  PageCloseButton: styled(Button)`color: blue;`,',
        '};',
        '',
        'export const items = [',
        '  styled(Vertical)`display: flex;`,',
        '];',
        '',
      ].join('\n')
    );

    try {
      const result = await runTransform(root, filename);

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('color:blue');
      expect(result.cssText).toContain('display:flex');
      expect(result.code).toContain(
        'const _exp = () => (Button);\nexport const HomeStyles'
      );
      expect(result.code).toContain(
        'const _exp2 = () => (Vertical);\nexport const items'
      );
      expect(result.code).toContain('styled(_exp())');
      expect(result.code).toContain('styled(_exp2())');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
