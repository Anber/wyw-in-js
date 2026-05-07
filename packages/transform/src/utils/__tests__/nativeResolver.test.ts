import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  clearNativeResolverCacheForTest,
  expandNativeResolverConditions,
  getNativeResolverCacheSizeForTest,
  resolveWithNativeResolver,
} from '../nativeResolver';

describe('nativeResolver', () => {
  afterEach(() => {
    clearNativeResolverCacheForTest();
  });

  it('expands conditionNames by resolver kind', () => {
    expect(expandNativeResolverConditions('import', ['custom', '...'])).toEqual(
      ['custom', 'node', 'import', 'default']
    );
    expect(
      expandNativeResolverConditions('dynamic-import', ['custom', '...'])
    ).toEqual(['custom', 'node', 'import', 'default']);
    expect(
      expandNativeResolverConditions('require', ['custom', '...'])
    ).toEqual(['custom', 'require', 'node', 'default']);
  });

  it('resolves with oxc resolver options and preserves request suffixes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-native-resolver-'));
    const entry = path.join(root, 'src', 'entry.ts');
    const aliased = path.join(root, 'fixtures', 'aliased.ts');

    try {
      mkdirSync(path.dirname(entry), { recursive: true });
      mkdirSync(path.dirname(aliased), { recursive: true });
      writeFileSync(entry, `export const entry = true;\n`);
      writeFileSync(aliased, `export const value = true;\n`);

      const resolved = resolveWithNativeResolver({
        conditionNames: [],
        extensions: ['.ts'],
        importer: entry,
        kind: 'import',
        oxcOptions: {
          resolver: {
            alias: {
              'alias-token': [aliased],
            },
          },
        },
        specifier: 'alias-token?raw',
      });

      expect(resolved).toBe(`${realpathSync(aliased)}?raw`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses tsconfig paths automatically by default', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-native-resolver-'));
    const entry = path.join(root, 'src', 'entry.ts');
    const aliased = path.join(root, 'src', 'tokens.ts');

    try {
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, `export const entry = true;\n`);
      writeFileSync(aliased, `export const token = true;\n`);
      writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['src/*'],
            },
          },
          include: ['src'],
        })
      );

      const resolved = resolveWithNativeResolver({
        conditionNames: [],
        extensions: ['.ts'],
        importer: entry,
        kind: 'import',
        specifier: '@/tokens',
      });

      expect(resolved).toBe(realpathSync(aliased));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds resolver factory cache', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-native-resolver-'));
    const entry = path.join(root, 'src', 'entry.ts');
    const dep = path.join(root, 'src', 'dep.ts');

    try {
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, `export const entry = true;\n`);
      writeFileSync(dep, `export const dep = true;\n`);

      for (let i = 0; i < 65; i += 1) {
        resolveWithNativeResolver({
          conditionNames: [`custom-${i}`, '...'],
          extensions: ['.ts'],
          importer: entry,
          kind: 'import',
          specifier: './dep',
        });
      }

      expect(getNativeResolverCacheSizeForTest()).toBe(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
