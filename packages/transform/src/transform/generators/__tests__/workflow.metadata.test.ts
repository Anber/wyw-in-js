import {
  createEntrypoint,
  createServices,
} from '../../__tests__/entrypoint-helpers';
import type { Services } from '../../types';
import { workflow } from '../workflow';

import {
  expectIteratorReturnResult,
  expectIteratorYieldResult,
} from './helpers';

const code = 'export const value = 1;';

describe('workflow metadata output', () => {
  let services: Services;

  beforeEach(() => {
    services = createServices();
    services.options = {
      pluginOptions: {
        outputMetadata: false,
      },
    } as Services['options'];
  });

  it('omits metadata when outputMetadata is disabled', () => {
    const entrypoint = createEntrypoint(services, '/src/entry.tsx', [], code);
    entrypoint.setTransformResult({
      code,
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
    });

    const action = entrypoint.createAction('workflow', undefined, null);
    const gen = workflow.call(action);

    let result = gen.next();
    expectIteratorYieldResult(result);
    expect(result.value[0]).toBe('processEntrypoint');

    result = gen.next(undefined);
    expectIteratorYieldResult(result);
    expect(result.value[0]).toBe('evalFile');

    result = gen.next([new Map(), ['/dep.ts']]);
    expectIteratorYieldResult(result);
    expect(result.value[0]).toBe('collect');

    result = gen.next({
      code,
      map: null,
      metadata: {
        dependencies: [],
        processors: [
          {
            artifacts: [['meta', { className: 'entry_a' }]],
            className: 'entry_a',
            displayName: 'entry',
            location: {
              end: { column: 15, line: 1 },
              start: { column: 0, line: 1 },
            },
          },
        ],
        replacements: [],
        rules: {
          '.entry_a': {
            className: 'entry_a',
            cssText: 'color:red;',
            displayName: 'entry',
            start: { column: 0, line: 1 },
          },
        },
      },
    });
    expectIteratorYieldResult(result);
    expect(result.value[0]).toBe('extract');

    const finalResult = gen.next({
      cssSourceMapText: '',
      cssText: '.entry_a{color:red;}',
      replacements: [],
      rules: {},
    });
    expectIteratorReturnResult(finalResult);
    expect(
      'metadata' in finalResult.value ? finalResult.value.metadata : undefined
    ).toBeUndefined();
  });

  it('returns normalized metadata when outputMetadata is enabled', () => {
    services.options = {
      pluginOptions: {
        outputMetadata: true,
      },
    } as Services['options'];

    const entrypoint = createEntrypoint(services, '/src/entry.tsx', [], code);
    entrypoint.setTransformResult({
      code,
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
    });

    const action = entrypoint.createAction('workflow', undefined, null);
    const gen = workflow.call(action);

    expectIteratorYieldResult(gen.next());
    expectIteratorYieldResult(gen.next(undefined));
    expectIteratorYieldResult(gen.next([new Map(), ['/dep.ts']]));
    expectIteratorYieldResult(
      gen.next({
        code,
        map: null,
        metadata: {
          dependencies: [],
          processors: [
            {
              artifacts: [['meta', { className: 'entry_a' }]],
              className: 'entry_a',
              displayName: 'entry',
              location: {
                end: { column: 15, line: 1 },
                start: { column: 0, line: 1 },
              },
            },
          ],
          replacements: [],
          rules: {
            '.entry_a': {
              className: 'entry_a',
              cssText: 'color:red;',
              displayName: 'entry',
              start: { column: 0, line: 1 },
            },
          },
        },
      })
    );

    const finalResult = gen.next({
      cssSourceMapText: '',
      cssText: '.entry_a{color:red;}',
      replacements: [],
      rules: {},
    });
    expectIteratorReturnResult(finalResult);
    expect(
      'metadata' in finalResult.value ? finalResult.value.metadata : undefined
    ).toEqual({
      dependencies: ['/dep.ts'],
      processors: [
        {
          artifacts: [['meta', { className: 'entry_a' }]],
          className: 'entry_a',
          displayName: 'entry',
          start: { column: 0, line: 1 },
        },
      ],
      replacements: [],
      rules: {
        '.entry_a': {
          className: 'entry_a',
          cssText: 'color:red;',
          displayName: 'entry',
          start: { column: 0, line: 1 },
        },
      },
    });
  });
});
