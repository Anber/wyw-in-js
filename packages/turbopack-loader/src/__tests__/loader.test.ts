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
  disposeEvalBroker: jest.fn(),
}));

describe('turbopack-loader', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('writes CSS next to the module and injects an import after directives by default', async () => {
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

  it('injects a CSS query import in query output mode without writing a sidecar file', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    fs.writeFileSync(resourcePath, "'use client'\\nexport const x = 1;\\n");

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
          getOptions: () => ({ cssOutputMode: 'query' }),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    const cssFilePath = path.join(tmpDir, 'entry.wyw-in-js.module.css');
    expect(fs.existsSync(cssFilePath)).toBe(false);

    expect(emitted.code).toContain("'use client'");
    expect(emitted.code).toContain('import "./entry.tsx?__wyw_css";');
  });

  it('returns CSS for the CSS query loader branch', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');

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
          getOptions: () => ({ outputCss: true }),
          getResolve: () => async () => false,
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    expect(emitted.code).toBe(':global(.a){color:red}');
  });

  it('keeps CSS output when Turbopack cannot post-resolve a package dependency', async () => {
    const { default: turbopackLoader } = await import('../index');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-turbo-'));
    const resourcePath = path.join(tmpDir, 'entry.tsx');
    const depPath = path.join(tmpDir, 'dep.tsx');
    fs.writeFileSync(resourcePath, 'export const x = 1;\n');
    fs.writeFileSync(depPath, 'export const y = 1;\n');

    transformMock.mockImplementation(async (_services, code) => {
      return {
        code,
        sourceMap: null,
        cssText: '.a{color:red}',
        dependencies: ['motion/react', './dep'],
      };
    });

    const addDependency = jest.fn();
    const resolveRequests: string[] = [];
    const emitted: { code?: string } = {};

    await new Promise<void>((resolve, reject) => {
      turbopackLoader.call(
        {
          addDependency,
          async: jest.fn(),
          callback: (err: Error | null, code?: string) => {
            if (err) reject(err);
            else {
              emitted.code = code;
              resolve();
            }
          },
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => async (_context: string, request: string) => {
            resolveRequests.push(request);

            if (request === 'motion/react') {
              throw new Error(
                "Unable to resolve module 'motion' with subpath '/react'"
              );
            }

            if (request === './dep') {
              return `${depPath}?compiled`;
            }

            return false;
          },
          resourcePath,
        } as any,
        fs.readFileSync(resourcePath, 'utf8'),
        null
      );
    });

    expect(resolveRequests).toEqual(['motion/react', './dep']);
    expect(addDependency).toHaveBeenCalledWith(depPath);
    expect(emitted.code).toContain('import "./entry.wyw-in-js.module.css";');
  });
});
