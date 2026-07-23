/* eslint-env jest */
import type { ProcessorStaticValue } from '@wyw-in-js/processor-utils';

import { EventEmitter } from '../../../utils/EventEmitter';
import { buildStaticPlan, emitStaticPlanDebug } from '../buildStaticPlan';
import type { StaticEnv } from '../types';

const filename = '/project/src/entry.tsx';
const processorImports = [
  {
    imported: 'css',
    local: 'css',
    source: 'test-css-processor',
  },
];
const cssTemplateSemantics = {
  kind: 'css-template' as const,
  outputs: ['class-name' as const, 'css-text' as const],
  runtimeDependencies: 'explicit' as const,
  staticInterpolations: [
    'serializable' as const,
    'class-name' as const,
    'selector-chain' as const,
  ],
};

describe('buildStaticPlan', () => {
  it('ignores imports that do not resolve to a processor implementation', () => {
    // Helper modules (e.g. a preeval runtime) import plain functions and call
    // them with values derived from function parameters. Those imports must
    // not be treated as processor locals, or planning their call arguments
    // would raise template-only hoisting diagnostics.
    const plan = buildStaticPlan({
      code: `
        import { normalizeParts, cloneStyle } from './support.js';

        export function makeStyle(...parts) {
          const style = normalizeParts(parts);
          return cloneStyle(style);
        }
      `,
      filename,
      options: {},
    });

    expect(plan.processorUsages).toEqual([]);
    expect(plan.attribution).toEqual(
      expect.objectContaining({
        usageCount: 0,
      })
    );
  });

  it('degrades to the eval path when call arguments reference function parameters', () => {
    // A real manifest-backed call processor used inside a function is not
    // statically resolvable. The plan must fall back instead of throwing.
    const plan = buildStaticPlan({
      code: `
        import { createTokenContract } from 'dx-tokens';

        export const makeContract = (shape) => {
          const normalized = { ...shape };
          return createTokenContract(normalized, { prefix: 'dyn' });
        };

        export const tokens = createTokenContract(
          { color: null },
          { prefix: 'dx' }
        );
      `,
      filename,
      processorImports: [
        {
          imported: 'createTokenContract',
          local: 'createTokenContract',
          semantics: {
            kind: 'token-contract-call' as const,
            prefixOption: 'prefix',
          },
          source: 'dx-tokens',
        },
      ],
    });

    expect(plan.attribution.usageCount).toBe(2);
    expect(plan.env.values.size).toBe(0);
  });

  it('records local serializable static values using ProcessorStaticValue', () => {
    const plan = buildStaticPlan({
      code: `
        import { css } from 'test-css-processor';
        const color = 'red';
        export const className = css\`
          color: ${'${color}'};
        \`;
      `,
      filename,
      processorImports,
    });

    const serializableValues = [...plan.env.values.entries()].filter(
      ([name, value]) =>
        /^_exp/.test(name) &&
        value.kind === 'serializable' &&
        value.value === 'red'
    );

    expect(plan.processorUsages).toEqual([
      expect.objectContaining({
        imported: 'css',
        kind: 'template',
        local: 'css',
        source: 'test-css-processor',
      }),
    ]);
    expect(serializableValues).toHaveLength(1);
    expect(plan.needs).toEqual([]);
    expect(plan.attribution).toEqual(
      expect.objectContaining({
        needCount: 0,
        unresolvedCount: 0,
        usageCount: 1,
      })
    );

    const runtimeCallback: ProcessorStaticValue = {
      kind: 'runtime-callback',
      source: 'callback',
    };
    const env: StaticEnv = {
      dependencies: new Set(),
      unresolved: new Map(),
      values: new Map([['callback', runtimeCallback]]),
    };

    expect(env.values.get('callback')).toEqual(runtimeCallback);
  });

  it('emits a StaticNeed for imported processor target bindings', () => {
    const plan = buildStaticPlan({
      code: `
        import { css } from 'test-css-processor';
        import { color } from './tokens';
        export const className = css\`
          color: ${'${color}'};
        \`;
      `,
      filename,
      processorImports,
    });

    expect(plan.env.values.size).toBe(0);
    expect([...plan.env.unresolved]).toEqual([
      [
        expect.stringMatching(/^_exp/),
        expect.objectContaining({
          kind: 'unresolved',
          reason: 'static-import',
        }),
      ],
    ]);
    expect(plan.needs).toEqual([
      {
        importer: filename,
        kind: 'export',
        name: 'color',
        reason: 'processor-static-interpolation',
        source: './tokens',
      },
    ]);
  });

  it('records runtime-only imports without emitting StaticNeeds', () => {
    const plan = buildStaticPlan({
      code: `
        import './runtime.css';
        import { css } from 'test-css-processor';
        export const className = css\`color: red;\`;
      `,
      filename,
      preparedImports: new Map([['./runtime.css', ['side-effect']]]),
      processorImports,
    });

    expect(plan.env.dependencies).toEqual(new Set(['./runtime.css']));
    expect(plan.needs).toEqual([]);
    expect(plan.attribution).toEqual(
      expect.objectContaining({
        needCount: 0,
        usageCount: 1,
      })
    );
  });

  it('records declarative processor semantics on usage plans', () => {
    const plan = buildStaticPlan({
      code: `
        import { css } from 'test-css-processor';
        export const className = css\`color: red;\`;
      `,
      filename,
      processorImports: [
        {
          imported: 'css',
          local: 'css',
          semantics: cssTemplateSemantics,
          source: 'test-css-processor',
        },
      ],
    });

    expect(plan.processorUsages).toEqual([
      expect.objectContaining({
        declarativeSemantics: cssTemplateSemantics,
        imported: 'css',
        kind: 'template',
        local: 'css',
        source: 'test-css-processor',
      }),
    ]);
  });

  it('emits plan-size attribution as a debug event', () => {
    const events: Record<string, unknown>[] = [];
    const eventEmitter = new EventEmitter(
      (labels, type) => {
        if (type === 'single') {
          events.push(labels);
        }
      },
      () => 0,
      () => {}
    );
    const plan = buildStaticPlan({
      code: `
        import { css } from 'test-css-processor';
        const color = 'red';
        export const className = css\`color: ${'${color}'};\`;
      `,
      filename,
      processorImports,
    });

    emitStaticPlanDebug(eventEmitter, plan);

    expect(events).toEqual([
      expect.objectContaining({
        filename,
        needCount: 0,
        type: 'staticPlan',
        unresolvedCount: 0,
        usageCount: 1,
      }),
    ]);
  });
});
