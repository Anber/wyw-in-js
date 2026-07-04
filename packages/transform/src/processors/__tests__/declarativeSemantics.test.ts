/* eslint-env jest */
import type {
  BaseProcessor,
  ProcessorStaticContext,
  ProcessorStaticValue,
} from '@wyw-in-js/processor-utils';

import {
  applyDeclarativeProcessorSemantics,
  normalizeDeclarativeProcessorSemantics,
} from '../declarativeSemantics';

const context: ProcessorStaticContext = {
  addDependency: () => {},
  debug: () => {},
  fileContext: {},
  metadata: {
    className: 'wyw-button',
    displayName: 'Button',
    isReferenced: true,
    location: null,
    slug: 'button',
    tagSource: {
      imported: 'css',
      source: '@wyw-in-js/test',
    },
  },
  options: {},
  unresolved: (reason, details) => ({
    ...(details ? { details } : {}),
    kind: 'unresolved',
    reason,
  }),
};

const createProcessor = (
  overrides: Partial<BaseProcessor> = {}
): BaseProcessor =>
  ({
    className: 'wyw-button',
    displayName: 'Button',
    isReferenced: true,
    location: null,
    slug: 'button',
    tagSource: {
      imported: 'css',
      source: '@wyw-in-js/test',
    },
    ...overrides,
  }) as BaseProcessor;

describe('declarative processor semantics', () => {
  it('adds css-template static class-name output without overriding JS hooks', () => {
    const explicitValue: ProcessorStaticValue = {
      className: 'wyw-button',
      kind: 'class-name',
      value: 'explicit-button',
    };
    const processor = createProcessor({
      getStaticValue: () => explicitValue,
    });

    expect(
      applyDeclarativeProcessorSemantics(processor, {
        kind: 'css-template',
        outputs: ['class-name', 'css-text'],
        runtimeDependencies: 'explicit',
        staticInterpolations: ['serializable', 'class-name', 'selector-chain'],
      })
    ).toBe(true);

    expect(processor.getStaticValue?.(context)).toBe(explicitValue);
  });

  it('projects css-template manifests to class-name static values', () => {
    const processor = createProcessor();

    expect(
      applyDeclarativeProcessorSemantics(processor, {
        kind: 'css-template',
        outputs: ['class-name', 'css-text'],
        runtimeDependencies: 'explicit',
        staticInterpolations: ['serializable', 'class-name', 'selector-chain'],
      })
    ).toBe(true);

    expect(processor.getStaticValue?.(context)).toEqual({
      className: 'wyw-button',
      kind: 'class-name',
      value: 'wyw-button',
    });
    expect(
      processor.resolveStaticInterpolation?.(
        {} as Parameters<
          NonNullable<BaseProcessor['resolveStaticInterpolation']>
        >[0],
        { kind: 'serializable', value: 'red' },
        context
      )
    ).toEqual({ kind: 'serializable', value: 'red' });
    expect(
      processor.resolveStaticInterpolation?.(
        {} as Parameters<
          NonNullable<BaseProcessor['resolveStaticInterpolation']>
        >[0],
        { kind: 'runtime-callback' },
        context
      )
    ).toEqual({
      details: {
        kind: 'runtime-callback',
      },
      kind: 'unresolved',
      reason: 'unsupported-css-template-interpolation',
    });
  });

  it('normalizes styled-target manifest semantics', () => {
    expect(
      normalizeDeclarativeProcessorSemantics({
        kind: 'styled-target',
        targets: ['class-name', 'selector-chain', 'opaque-component'],
      })
    ).toEqual({
      kind: 'styled-target',
      targets: ['class-name', 'selector-chain', 'opaque-component'],
    });
  });

  it('ignores unsupported declarative semantics so JS implementation remains the fallback', () => {
    const processor = createProcessor();

    expect(
      normalizeDeclarativeProcessorSemantics({ kind: 'future-processor' })
    ).toBeNull();
    expect(
      applyDeclarativeProcessorSemantics(processor, {
        kind: 'future-processor',
      })
    ).toBe(false);
    expect(processor.getStaticValue).toBeUndefined();
  });
});
