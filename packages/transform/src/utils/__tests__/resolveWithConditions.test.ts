import * as childProcess from 'child_process';

import { resolveFilenameWithConditions } from '../resolveWithConditions';

const parent = {
  filename: '/tmp/entry.js',
  id: '/tmp/entry.js',
  paths: ['/tmp/node_modules'],
};

describe('resolveFilenameWithConditions', () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: originalExecPath,
    });
  });

  it('uses the local module implementation outside Bun', () => {
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: '/usr/local/bin/node',
    });

    const moduleImpl = {
      _resolveFilename: jest.fn(() => '/tmp/resolved.js'),
    };

    expect(
      resolveFilenameWithConditions(
        moduleImpl,
        'pkg/file',
        parent,
        new Set(['custom'])
      )
    ).toBe('/tmp/resolved.js');
    expect(moduleImpl._resolveFilename).toHaveBeenCalledWith(
      'pkg/file',
      parent,
      false,
      {
        conditions: new Set(['custom']),
      }
    );
  });

  it('delegates conditioned resolution to Node when running under Bun', () => {
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: '/usr/local/bin/bun',
    });

    const spawnSyncSpy = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
      error: undefined,
      output: ['', '{"resolved":"/tmp/resolved.js"}', ''],
      pid: 123,
      signal: null,
      status: 0,
      stderr: '',
      stdout: '{"resolved":"/tmp/resolved.js"}',
    } as never);
    const moduleImpl = {
      _resolveFilename: jest.fn(() => '/tmp/unused.js'),
    };

    expect(
      resolveFilenameWithConditions(
        moduleImpl,
        'pkg/file',
        parent,
        new Set(['custom', 'node'])
      )
    ).toBe('/tmp/resolved.js');
    expect(moduleImpl._resolveFilename).not.toHaveBeenCalled();
    expect(spawnSyncSpy).toHaveBeenCalledWith(
      'node',
      ['-e', expect.stringContaining('Module._resolveFilename')],
      expect.objectContaining({
        encoding: 'utf8',
        input: expect.any(String),
      })
    );
    expect(
      JSON.parse(
        (spawnSyncSpy.mock.calls[0][2] as { input: string }).input
      ) as {
        conditions: string[];
        id: string;
        parent: typeof parent;
      }
    ).toEqual({
      conditions: ['custom', 'node'],
      id: 'pkg/file',
      parent,
    });
  });

  it('rethrows Node fallback resolution errors with their errno code', () => {
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: '/usr/local/bin/bun',
    });

    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
      error: undefined,
      output: [
        '',
        '{"error":{"code":"MODULE_NOT_FOUND","message":"cannot resolve"}}',
        '',
      ],
      pid: 123,
      signal: null,
      status: 1,
      stderr: '',
      stdout:
        '{"error":{"code":"MODULE_NOT_FOUND","message":"cannot resolve"}}',
    } as never);

    let thrown: unknown;
    try {
      resolveFilenameWithConditions(
        {
          _resolveFilename: jest.fn(() => '/tmp/unused.js'),
        },
        'pkg/file',
        parent,
        new Set(['custom'])
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('cannot resolve');
    expect((thrown as NodeJS.ErrnoException).code).toBe('MODULE_NOT_FOUND');
  });
});
