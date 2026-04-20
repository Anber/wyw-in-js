// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from 'bun:test';

import { getPackageName } from '../analyze';

describe('getPackageName', () => {
  test('returns package name for bare specifiers', () => {
    expect(getPackageName('react')).toBe('react');
    expect(getPackageName('react/jsx-runtime')).toBe('react');
    expect(getPackageName('@radix-ui/react-dialog')).toBe(
      '@radix-ui/react-dialog'
    );
    expect(getPackageName('@radix-ui/react-dialog/dist/index.js')).toBe(
      '@radix-ui/react-dialog'
    );
  });

  test('extracts package from node_modules path (npm/yarn)', () => {
    expect(getPackageName('/repo/node_modules/react/index.js')).toBe('react');
    expect(
      getPackageName('/repo/node_modules/@radix-ui/react-dialog/index.js')
    ).toBe('@radix-ui/react-dialog');
    expect(getPackageName('node_modules/react/index.js')).toBe('react');
    expect(getPackageName('node_modules/@radix-ui/react-dialog/index.js')).toBe(
      '@radix-ui/react-dialog'
    );
  });

  test('extracts package from pnpm node_modules path', () => {
    expect(
      getPackageName(
        '/repo/node_modules/.pnpm/react@18.2.0/node_modules/react/index.js'
      )
    ).toBe('react');

    expect(
      getPackageName(
        '/repo/node_modules/.pnpm/@radix-ui+react-dialog@1.0.5_react@18.2.0/node_modules/@radix-ui/react-dialog/dist/index.js'
      )
    ).toBe('@radix-ui/react-dialog');

    expect(
      getPackageName(
        'node_modules/.pnpm/react@18.2.0/node_modules/react/index.js'
      )
    ).toBe('react');
  });

  test('handles windows path separators', () => {
    expect(
      getPackageName(
        'C:\\\\repo\\\\node_modules\\\\.pnpm\\\\react@18.2.0\\\\node_modules\\\\react\\\\index.js'
      )
    ).toBe('react');
  });

  test('strips query/hash from paths', () => {
    expect(getPackageName('/repo/node_modules/react/index.js?foo=1')).toBe(
      'react'
    );
    expect(getPackageName('/repo/node_modules/react/index.js#bar')).toBe(
      'react'
    );
  });

  test('collapses project paths', () => {
    expect(getPackageName('src/components/Button.tsx')).toBe('(project)');
    expect(getPackageName('./src/components/Button.tsx')).toBe('(project)');
    expect(getPackageName('/repo/src/components/Button.tsx')).toBe('(project)');
    expect(getPackageName('C:/repo/src/components/Button.tsx')).toBe(
      '(project)'
    );
  });
});
