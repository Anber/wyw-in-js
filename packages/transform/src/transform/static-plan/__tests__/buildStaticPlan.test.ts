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

describe('buildStaticPlan', () => {
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
