import type {
  BaseProcessor,
  CallParam,
  Params,
  ProcessorStaticInterpolationResolver,
  ProcessorStaticTagTargetResolver,
  ProcessorStaticValue,
} from '@wyw-in-js/processor-utils';
import type { ExpressionValue } from '@wyw-in-js/shared';

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

export type StyleObjectCallSemantics = {
  cssDescriptorKind: string;
  descriptorKey: string;
  kind: 'style-object-call';
  styleHandleKind: string;
};

export type CssVarCallSemantics = {
  kind: 'css-var-call';
};

export type TokenContractCallSemantics = {
  kind: 'token-contract-call';
  prefixOption: string;
};

export type ClassNameCallSemantics = {
  kind: 'class-name-call';
};

export type DeclarativeProcessorCallSemantics =
  | ClassNameCallSemantics
  | CssVarCallSemantics
  | StyleObjectCallSemantics
  | TokenContractCallSemantics;

export type DeclarativeProcessorSemantics =
  | CssTemplateSemantics
  | DeclarativeProcessorCallSemantics
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
const DEFAULT_DX_STYLES_DESCRIPTOR_KEY = '__dxStyles';
const DEFAULT_DX_STYLES_CSS_DESCRIPTOR_KIND = 'css';
const DEFAULT_DX_STYLES_STYLE_HANDLE_KIND = 'styleHandle';
const DEFAULT_TOKEN_CONTRACT_PREFIX_OPTION = 'prefix';

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

const readString = (value: unknown, fallback: string): string | null => {
  if (value === undefined) {
    return fallback;
  }

  return typeof value === 'string' && value.length > 0 ? value : null;
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

  if (semantics.kind === 'style-object-call') {
    const descriptorKey = readString(
      semantics.descriptorKey,
      DEFAULT_DX_STYLES_DESCRIPTOR_KEY
    );
    const cssDescriptorKind = readString(
      semantics.cssDescriptorKind,
      DEFAULT_DX_STYLES_CSS_DESCRIPTOR_KIND
    );
    const styleHandleKind = readString(
      semantics.styleHandleKind,
      DEFAULT_DX_STYLES_STYLE_HANDLE_KIND
    );

    return descriptorKey && cssDescriptorKind && styleHandleKind
      ? {
          cssDescriptorKind,
          descriptorKey,
          kind: 'style-object-call',
          styleHandleKind,
        }
      : null;
  }

  if (semantics.kind === 'css-var-call') {
    return {
      kind: 'css-var-call',
    };
  }

  if (semantics.kind === 'token-contract-call') {
    const prefixOption = readString(
      semantics.prefixOption,
      DEFAULT_TOKEN_CONTRACT_PREFIX_OPTION
    );

    return prefixOption
      ? {
          kind: 'token-contract-call',
          prefixOption,
        }
      : null;
  }

  if (semantics.kind === 'class-name-call') {
    return {
      kind: 'class-name-call',
    };
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

type DeclarativeProcessorCallState = {
  expressions: ExpressionValue[];
  semantics: DeclarativeProcessorCallSemantics;
};

export type DeclarativeCallInputResolution =
  | { resolved: false }
  | { resolved: true; value: unknown };

const declarativeCallState = new WeakMap<
  BaseProcessor,
  DeclarativeProcessorCallState
>();

const isCallParam = (param: Params[number]): param is CallParam =>
  param[0] === 'call';

const getCallExpressions = (params?: Params): ExpressionValue[] | null => {
  const callParam = params?.find(isCallParam);
  if (!callParam) {
    return null;
  }

  const [, ...expressions] = callParam;
  return expressions;
};

const cssVarStaticValue = (processor: BaseProcessor): ProcessorStaticValue => ({
  kind: 'serializable',
  value: `var(--${processor.className})`,
});

const classNameCallStaticValue = (
  processor: BaseProcessor
): ProcessorStaticValue => ({
  className: processor.className,
  kind: 'class-name',
  value: processor.className,
});

const descriptorFor = (
  value: unknown,
  descriptorKey: string
): Record<string, unknown> | null => {
  if (!isRecord(value)) {
    return null;
  }

  const descriptor = value[descriptorKey];
  return isRecord(descriptor) ? descriptor : null;
};

const splitClassNameTokens = (className: string): string[] =>
  className.split(/\s+/u).filter((token) => token.length > 0);

const addClassNameTokens = (target: Set<string>, className: string): void => {
  splitClassNameTokens(className).forEach((token) => target.add(token));
};

const mergeStyle = (
  target: Record<string, unknown>,
  style: Record<string, unknown>
): Record<string, unknown> => ({ ...target, ...style });

const resolveStyleObjectCall = (
  processor: BaseProcessor,
  semantics: StyleObjectCallSemantics,
  args: unknown[]
): ProcessorStaticValue | null => {
  let style: Record<string, unknown> = {};
  const classNames = new Set<string>();

  for (const arg of args) {
    if (arg !== undefined && arg !== null && arg !== false) {
      const descriptor = descriptorFor(arg, semantics.descriptorKey);
      if (descriptor?.kind === semantics.styleHandleKind) {
        const { className } = descriptor;
        if (typeof className !== 'string') {
          return null;
        }
        addClassNameTokens(classNames, className);
      } else if (descriptor?.kind === semantics.cssDescriptorKind) {
        const { classNameRefs } = descriptor;
        if (Array.isArray(classNameRefs)) {
          classNameRefs.forEach((className) => {
            if (typeof className === 'string') {
              addClassNameTokens(classNames, className);
            }
          });
        }
        if (!isRecord(descriptor.style)) {
          return null;
        }
        style = mergeStyle(style, descriptor.style);
      } else if (isRecord(arg)) {
        style = mergeStyle(style, arg);
      } else {
        return null;
      }
    }
  }

  const shouldEmitLocalRule =
    Object.keys(style).length > 0 || classNames.size === 0;
  const runtimeClassName = [
    ...classNames,
    shouldEmitLocalRule ? processor.className : undefined,
  ]
    .filter((className): className is string => !!className)
    .join(' ');

  return {
    className: processor.className,
    kind: 'class-name',
    value: runtimeClassName,
  };
};

interface TokenContractObject {
  [key: string]: string | TokenContractObject;
}

const buildContractLeafName = (
  prefix: string,
  path: string[],
  explicitName: string | null
): string => {
  const leafName =
    explicitName !== null && explicitName.length > 0
      ? explicitName
      : path.join('-');
  return leafName.startsWith('--') ? leafName : `--${prefix}-${leafName}`;
};

const buildTokenContractObject = (
  shape: Record<string, unknown>,
  prefix: string,
  path: string[]
): TokenContractObject => {
  const result: TokenContractObject = {};

  Object.keys(shape).forEach((key) => {
    const value = shape[key];
    const nextPath = [...path, key];

    result[key] = isRecord(value)
      ? buildTokenContractObject(value, prefix, nextPath)
      : `var(${buildContractLeafName(
          prefix,
          nextPath,
          typeof value === 'string' ? value : null
        )})`;
  });

  return result;
};

const resolveTokenContractCall = (
  semantics: TokenContractCallSemantics,
  args: unknown[]
): ProcessorStaticValue | null => {
  const [shape, options] = args;
  if (!isRecord(shape) || !isRecord(options)) {
    return null;
  }

  const prefix = options[semantics.prefixOption];
  if (typeof prefix !== 'string' || prefix.trim().length === 0) {
    return null;
  }

  return {
    kind: 'serializable',
    value: buildTokenContractObject(shape, prefix.trim(), []),
  };
};

export const resolveDeclarativeProcessorStaticValue = (
  processor: BaseProcessor,
  resolveInput: (expression: ExpressionValue) => DeclarativeCallInputResolution
): ProcessorStaticValue | null => {
  const state = declarativeCallState.get(processor);
  if (!state) {
    return null;
  }

  const args: unknown[] = [];
  for (const expression of state.expressions) {
    const resolved = resolveInput(expression);
    if (!resolved.resolved) {
      return null;
    }
    args.push(resolved.value);
  }

  if (state.semantics.kind === 'style-object-call') {
    return resolveStyleObjectCall(processor, state.semantics, args);
  }

  if (state.semantics.kind === 'token-contract-call') {
    return resolveTokenContractCall(state.semantics, args);
  }

  return null;
};

export const applyDeclarativeProcessorSemantics = (
  processor: BaseProcessor,
  semantics: unknown,
  params?: Params
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

  if (normalized.kind === 'styled-target') {
    if (!processor.resolveStaticTagTarget) {
      Object.defineProperty(processor, 'resolveStaticTagTarget', {
        configurable: true,
        value: styledTargetResolver(normalized),
      });
    }

    return true;
  }

  if (normalized.kind === 'css-var-call') {
    if (!processor.getStaticValue) {
      Object.defineProperty(processor, 'getStaticValue', {
        configurable: true,
        value: () => cssVarStaticValue(processor),
      });
    }

    return true;
  }

  if (normalized.kind === 'class-name-call') {
    if (!processor.getStaticValue) {
      Object.defineProperty(processor, 'getStaticValue', {
        configurable: true,
        value: () => classNameCallStaticValue(processor),
      });
    }

    return true;
  }

  const expressions = getCallExpressions(params);
  if (expressions) {
    declarativeCallState.set(processor, {
      expressions,
      semantics: normalized,
    });
  }

  return true;
};
