import type {
  BaseProcessor,
  ProcessorStaticInterpolationResolver,
  ProcessorStaticTagTargetResolver,
  ProcessorStaticValue,
} from '@wyw-in-js/processor-utils';

type CssTemplateOutput = 'class-name' | 'css-text';
type RuntimeDependencyMode = 'explicit';
type StaticInterpolationKind = ProcessorStaticValue['kind'];
type StyledTargetKind = 'class-name' | 'opaque-component' | 'selector-chain';

export type CssTemplateSemantics = {
  kind: 'css-template';
  outputs: CssTemplateOutput[];
  runtimeDependencies: RuntimeDependencyMode;
  staticInterpolations: StaticInterpolationKind[];
};

export type StyledTargetSemantics = {
  kind: 'styled-target';
  targets: StyledTargetKind[];
};

export type DeclarativeProcessorSemantics =
  | CssTemplateSemantics
  | StyledTargetSemantics;

const CSS_TEMPLATE_OUTPUTS = new Set<CssTemplateOutput>([
  'class-name',
  'css-text',
]);
const STATIC_INTERPOLATION_KINDS = new Set<StaticInterpolationKind>([
  'class-name',
  'opaque-component',
  'runtime-callback',
  'selector-chain',
  'serializable',
  'unresolved',
]);
const STYLED_TARGET_KINDS = new Set<StyledTargetKind>([
  'class-name',
  'opaque-component',
  'selector-chain',
]);

const DEFAULT_CSS_TEMPLATE_OUTPUTS: CssTemplateOutput[] = [
  'class-name',
  'css-text',
];
const DEFAULT_CSS_TEMPLATE_STATIC_INTERPOLATIONS: StaticInterpolationKind[] = [
  'serializable',
  'class-name',
  'selector-chain',
];
const DEFAULT_STYLED_TARGET_KINDS: StyledTargetKind[] = [
  'class-name',
  'selector-chain',
  'opaque-component',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStringArray = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  fallback: T[]
): T[] | null => {
  if (value === undefined) {
    return [...fallback];
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item as T)) {
      return null;
    }

    result.push(item as T);
  }

  return result;
};

export const normalizeDeclarativeProcessorSemantics = (
  semantics: unknown
): DeclarativeProcessorSemantics | null => {
  if (!isRecord(semantics)) {
    return null;
  }

  if (semantics.kind === 'css-template') {
    const outputs = readStringArray(
      semantics.outputs,
      CSS_TEMPLATE_OUTPUTS,
      DEFAULT_CSS_TEMPLATE_OUTPUTS
    );
    const staticInterpolations = readStringArray(
      semantics.staticInterpolations,
      STATIC_INTERPOLATION_KINDS,
      DEFAULT_CSS_TEMPLATE_STATIC_INTERPOLATIONS
    );
    const runtimeDependencies =
      semantics.runtimeDependencies === undefined
        ? 'explicit'
        : semantics.runtimeDependencies;

    if (
      !outputs ||
      !staticInterpolations ||
      runtimeDependencies !== 'explicit'
    ) {
      return null;
    }

    return {
      kind: 'css-template',
      outputs,
      runtimeDependencies,
      staticInterpolations,
    };
  }

  if (semantics.kind === 'styled-target') {
    const targets = readStringArray(
      semantics.targets,
      STYLED_TARGET_KINDS,
      DEFAULT_STYLED_TARGET_KINDS
    );

    return targets
      ? {
          kind: 'styled-target',
          targets,
        }
      : null;
  }

  return null;
};

const cssTemplateStaticValue = (
  processor: BaseProcessor
): ProcessorStaticValue => ({
  className: processor.className,
  kind: 'class-name',
  value: processor.className,
});

const cssTemplateInterpolationResolver = (
  semantics: CssTemplateSemantics
): ProcessorStaticInterpolationResolver => {
  const allowedKinds = new Set(semantics.staticInterpolations);

  return (_interpolation, value, context) =>
    allowedKinds.has(value.kind)
      ? value
      : context.unresolved('unsupported-css-template-interpolation', {
          kind: value.kind,
        });
};

const staticValueToMetaExtends = (
  target: ProcessorStaticValue
): unknown | null => {
  if (target.kind === 'selector-chain') {
    return target.value ?? null;
  }

  if (target.kind === 'opaque-component') {
    return target.value ?? null;
  }

  return null;
};

const styledTargetResolver = (
  semantics: StyledTargetSemantics
): ProcessorStaticTagTargetResolver => {
  const allowedKinds = new Set<ProcessorStaticValue['kind']>(semantics.targets);

  return (target, context) => {
    if (!allowedKinds.has(target.kind)) {
      return context.unresolved('unsupported-styled-target', {
        kind: target.kind,
      });
    }

    const { className } = context.metadata;
    const targetSelectors =
      target.kind === 'selector-chain' ? target.selectors : [];

    return {
      className,
      kind: 'selector-chain',
      selectors: [`.${className}`, ...targetSelectors],
      value: {
        __wyw_meta: {
          className,
          extends: staticValueToMetaExtends(target),
        },
      },
    };
  };
};

export const applyDeclarativeProcessorSemantics = (
  processor: BaseProcessor,
  semantics: unknown
): boolean => {
  const normalized = normalizeDeclarativeProcessorSemantics(semantics);
  if (!normalized) {
    return false;
  }

  if (normalized.kind === 'css-template') {
    if (
      !processor.getStaticValue &&
      normalized.outputs.includes('class-name')
    ) {
      Object.defineProperty(processor, 'getStaticValue', {
        configurable: true,
        value: () => cssTemplateStaticValue(processor),
      });
    }

    if (!processor.resolveStaticInterpolation) {
      Object.defineProperty(processor, 'resolveStaticInterpolation', {
        configurable: true,
        value: cssTemplateInterpolationResolver(normalized),
      });
    }

    return true;
  }

  if (!processor.resolveStaticTagTarget) {
    Object.defineProperty(processor, 'resolveStaticTagTarget', {
      configurable: true,
      value: styledTargetResolver(normalized),
    });
  }

  return true;
};
