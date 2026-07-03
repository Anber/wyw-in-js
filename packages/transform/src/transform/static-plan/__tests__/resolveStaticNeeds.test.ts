/* eslint-env jest */

import {
  planStaticNeedRequests,
  resolveUnmetStaticNeeds,
} from '../resolveStaticNeeds';
import type { StaticNeed } from '../types';

const importer = '/project/src/entry.tsx';

describe('planStaticNeedRequests', () => {
  it('groups repeated export needs by importer and source with minimal only', () => {
    const needs: StaticNeed[] = [
      {
        importer,
        kind: 'export',
        name: 'color',
        reason: 'processor-static-interpolation',
        source: './tokens',
      },
      {
        importer,
        kind: 'export',
        name: 'space',
        reason: 'processor-static-interpolation',
        source: './tokens',
      },
      {
        importer,
        kind: 'export',
        name: 'color',
        reason: 'processor-metadata',
        source: './tokens',
      },
    ];

    expect(planStaticNeedRequests(needs)).toEqual([
      {
        importer,
        kind: 'dependency',
        only: ['color', 'space'],
        reasons: ['processor-static-interpolation', 'processor-metadata'],
        source: './tokens',
      },
    ]);
  });

  it('keeps processor metadata needs as dependency requests for exportName', () => {
    expect(
      planStaticNeedRequests([
        {
          exportName: 'theme',
          importer,
          kind: 'processor-metadata',
          reason: 'processor-metadata',
          source: './theme',
        },
      ])
    ).toEqual([
      {
        importer,
        kind: 'dependency',
        only: ['theme'],
        reasons: ['processor-metadata'],
        source: './theme',
      },
    ]);
  });

  it('keeps eval needs limited to unresolved names', () => {
    expect(
      planStaticNeedRequests([
        {
          importer,
          kind: 'eval',
          only: ['dynamicColor', 'dynamicSpace'],
          reason: 'unresolved-static-value',
          source: importer,
        },
      ])
    ).toEqual([
      {
        importer,
        kind: 'eval',
        only: ['dynamicColor', 'dynamicSpace'],
        reasons: ['unresolved-static-value'],
        source: importer,
      },
    ]);
  });
});

describe('resolveUnmetStaticNeeds', () => {
  it('creates eval requests only for unresolved names', () => {
    const needs = resolveUnmetStaticNeeds({
      filename: importer,
      resolvedNames: new Set(['staticColor', 'runtimeCallback']),
      runtimeOnlyNames: new Set(['runtimeCallback']),
      unresolvedNames: ['staticColor', 'dynamicColor', 'runtimeCallback'],
    });

    expect(needs).toEqual([
      {
        importer,
        kind: 'eval',
        only: ['dynamicColor'],
        reason: 'unresolved-static-value',
        source: importer,
      },
    ]);
    expect(planStaticNeedRequests(needs)).toEqual([
      {
        importer,
        kind: 'eval',
        only: ['dynamicColor'],
        reasons: ['unresolved-static-value'],
        source: importer,
      },
    ]);
  });

  it('does not request eval when every static need is resolved statically', () => {
    expect(
      resolveUnmetStaticNeeds({
        filename: importer,
        resolvedNames: new Set(['staticColor']),
        runtimeOnlyNames: new Set(['runtimeCallback']),
        unresolvedNames: ['staticColor', 'runtimeCallback'],
      })
    ).toEqual([]);
  });
});
