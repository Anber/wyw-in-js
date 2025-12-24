import type { PluginBuild } from 'esbuild';

import wywInJS from '../index';

const createBuild = (): PluginBuild => {
  return {
    onLoad: jest.fn(),
    onResolve: jest.fn(),
    onEnd: jest.fn(),
    resolve: jest.fn().mockResolvedValue({ errors: [], path: '' }),
    initialOptions: {},
  } as unknown as PluginBuild;
};

const getOnLoadFilter = (build: PluginBuild): RegExp => {
  const call = (build.onLoad as jest.Mock).mock.calls.find(
    ([options]) => !('namespace' in options)
  );
  if (!call) {
    throw new Error('Expected onLoad registration for main filter.');
  }
  return call[0].filter as RegExp;
};

describe('esbuild filter normalization', () => {
  it('sanitizes unsupported flags and warns', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const build = createBuild();

    wywInJS({ filter: /\.styles\.ts$/gu }).setup(build);

    const filter = getOnLoadFilter(build);
    expect(filter.flags).toBe('');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('unsupported RegExp flags');
    expect(message).toContain('g');
    expect(message).toContain('u');

    warnSpy.mockRestore();
  });

  it('keeps supported flags without warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const build = createBuild();

    wywInJS({ filter: /\.styles\.ts$/ims }).setup(build);

    const filter = getOnLoadFilter(build);
    expect(filter.flags.split('').sort().join('')).toBe('ims');
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
