import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TransformCacheCollection } from '../cache';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';

describe('loadAndParse', () => {
  it('does not read from filesystem for ignored extensions with ?query', async () => {
    const { loadAndParse } = await import('../transform/Entrypoint.helpers');
    const log = jest.fn();

    const res = loadAndParse(
      {
        babel: {},
        eventEmitter: {},
        options: {
          pluginOptions: {
            extensions: ['.js', '.ts', '.tsx'],
            rules: [],
          },
        },
      },
      '/abs/icon.svg?svgUse',
      undefined,
      log
    );

    expect(res).toMatchObject({
      evaluator: 'ignored',
      reason: 'extension',
    });

    expect(() => (res as any).code).not.toThrow();
    expect((res as any).code).toBeUndefined();
  });

  it('reuses cached initialCode when loadedCode is undefined', async () => {
    const { loadAndParse } = await import('../transform/Entrypoint.helpers');

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wyw-load-and-parse-')
    );
    const filename = path.join(tmpDir, 'fixture.ts');

    try {
      fs.writeFileSync(filename, 'export const value = "from-disk";', 'utf8');

      const cache = new TransformCacheCollection();
      cache.add('entrypoints', filename, {
        dependencies: new Map(),
        generation: 1,
        initialCode: 'export const value = "from-cache";',
        name: filename,
      } as any);

      const services = withDefaultServices({
        cache,
        options: {
          filename,
          root: tmpDir,
          pluginOptions: loadWywOptions({
            features: { useBabelConfigs: false },
            rules: [],
          }),
        } as any,
      });

      const res = loadAndParse(services, filename, undefined, jest.fn());

      expect(res).toMatchObject({ evaluator: 'ignored', reason: 'rule' });
      expect((res as any).code).toBe('export const value = "from-cache";');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
