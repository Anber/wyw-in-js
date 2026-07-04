/* eslint-env jest */
import type {
  BaseProcessor,
  ProcessorStaticContext,
  ProcessorStaticValue,
} from '@wyw-in-js/processor-utils';

import {
  applyDeclarativeProcessorSemantics,
  normalizeDeclarativeProcessorSemantics,
  resolveDeclarativeProcessorStaticValue,
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

  it('normalizes dx-styles call manifest semantics', () => {
    expect(
      normalizeDeclarativeProcessorSemantics({
        kind: 'style-object-call',
      })
    ).toEqual({
      cssDescriptorKind: 'css',
      descriptorKey: '__dxStyles',
      kind: 'style-object-call',
      styleHandleKind: 'styleHandle',
    });
    expect(
      normalizeDeclarativeProcessorSemantics({
        kind: 'css-var-call',
      })
    ).toEqual({
      kind: 'css-var-call',
    });
    expect(
      normalizeDeclarativeProcessorSemantics({
        kind: 'token-contract-call',
      })
    ).toEqual({
      kind: 'token-contract-call',
      prefixOption: 'prefix',
    });
    expect(
      normalizeDeclarativeProcessorSemantics({
        kind: 'class-name-call',
      })
    ).toEqual({
      kind: 'class-name-call',
    });
  });

  it('rejects malformed dx-styles call manifest semantics', () => {
    expect(
      normalizeDeclarativeProcessorSemantics({
        descriptorKey: '',
        kind: 'style-object-call',
      })
    ).toBeNull();
    expect(
      normalizeDeclarativeProcessorSemantics({
        kind: 'token-contract-call',
        prefixOption: '',
      })
    ).toBeNull();
    expect(
      normalizeDeclarativeProcessorSemantics({
        kind: 'style-object-call',
        styleHandleKind: 42,
      })
    ).toBeNull();
  });

  it('does not attach an unsafe argument-free static value for style-object calls', () => {
    const processor = createProcessor();

    expect(
      applyDeclarativeProcessorSemantics(processor, {
        kind: 'style-object-call',
      })
    ).toBe(true);
    expect(processor.getStaticValue).toBeUndefined();
  });

  it('resolves dx-styles call static values only when call inputs are known', () => {
    const expression = {
      ex: { name: '_exp', type: 'Identifier' },
      kind: 0,
      source: 'handle',
    };
    const processor = createProcessor();

    applyDeclarativeProcessorSemantics(
      processor,
      {
        kind: 'style-object-call',
      },
      [
        ['callee', {}],
        ['call', expression],
      ] as Parameters<typeof applyDeclarativeProcessorSemantics>[2]
    );

    expect(
      resolveDeclarativeProcessorStaticValue(processor, () => ({
        resolved: false,
      }))
    ).toBeNull();
    expect(
      resolveDeclarativeProcessorStaticValue(processor, () => ({
        resolved: true,
        value: {
          __dxStyles: {
            className: 'dx-handle',
            kind: 'styleHandle',
          },
        },
      }))
    ).toEqual({
      className: 'wyw-button',
      kind: 'class-name',
      value: 'dx-handle',
    });
  });

  it('resolves token contract call static values', () => {
    const shapeExpression = {
      ex: { name: '_shape', type: 'Identifier' },
      kind: 0,
      source: '{ color: null }',
    };
    const optionsExpression = {
      ex: { name: '_options', type: 'Identifier' },
      kind: 0,
      source: "{ prefix: 'dx' }",
    };
    const processor = createProcessor();

    applyDeclarativeProcessorSemantics(
      processor,
      {
        kind: 'token-contract-call',
      },
      [
        ['callee', {}],
        ['call', shapeExpression, optionsExpression],
      ] as Parameters<typeof applyDeclarativeProcessorSemantics>[2]
    );

    expect(
      resolveDeclarativeProcessorStaticValue(processor, (input) => {
        if (input === shapeExpression) {
          return { resolved: true, value: { color: null } };
        }
        return {
          resolved: true,
          value: { prefix: 'dx' },
        };
      })
    ).toEqual({
      kind: 'serializable',
      value: {
        color: 'var(--dx-color)',
      },
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
