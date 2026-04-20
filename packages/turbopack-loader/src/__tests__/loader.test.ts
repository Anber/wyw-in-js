import fs from 'fs';
import os from 'os';
import path from 'path';

const transformMock = jest.fn();

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: jest.fn(),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

describe('turbopack-loader', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('writes CSS next to the module and injects an import after directives', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    const configFile = path.join(tmpDir, 'wyw.config.js');
    fs.writeFileSync(resourcePath, "'use client'\\nexport const x = 1;\\n");
    fs.writeFileSync(configFile, 'module.exports = {};\\n');

    transformMock.mockImplementation(async (_services, code) => {
      return {
        code,
        sourceMap: null,
        cssText: '.a{color:red}',
        dependencies: [],
      };
    });

    const emitted: { code?: string } = {};

    await new Promise<void>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, code?: string) => {
            if (err) reject(err);
            else {
              emitted.code = code;
              resolve();
            }
          },
          emitWarning: jest.fn(),
          getOptions: () => ({ configFile }),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    const cssFilePath = path.join(tmpDir, 'entry.wyw-in-js.module.css');
    expect(fs.readFileSync(cssFilePath, 'utf8')).toBe(':global(.a){color:red}');

    expect(emitted.code).toContain("'use client'");
    expect(emitted.code).toContain('import "./entry.wyw-in-js.module.css";');
  });
});
