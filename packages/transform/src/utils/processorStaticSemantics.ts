import type {
  BaseProcessor,
  Expression as ProcessorExpression,
  ProcessorStaticContext,
  ProcessorStaticValue,
} from '@wyw-in-js/processor-utils';

export const unknownProcessorStaticValue = Symbol(
  'unknownProcessorStaticValue'
);

export type UnknownProcessorStaticValue = typeof unknownProcessorStaticValue;

type ProcessorWithStaticInternals = BaseProcessor & {
  context?: ProcessorStaticContext['fileContext'];
  options?: ProcessorStaticContext['options'];
};

export const createProcessorStaticContext = (
  processor: BaseProcessor
): ProcessorStaticContext => {
  const processorWithInternals = processor as ProcessorWithStaticInternals;

  return {
    addDependency: () => {},
    debug: () => {},
    fileContext:
      processorWithInternals.context ??
      ({} as ProcessorStaticContext['fileContext']),
    metadata: {
      className: processor.className,
      displayName: processor.displayName,
      isReferenced: processor.isReferenced,
      location: processor.location,
      slug: processor.slug,
      tagSource: processor.tagSource,
    },
    options:
      processorWithInternals.options ??
      ({} as ProcessorStaticContext['options']),
    unresolved: (reason, details) => ({
      ...(details ? { details } : {}),
      kind: 'unresolved',
      reason,
    }),
  };
};

export const isProcessorStaticValue = (
  value: unknown
): value is ProcessorStaticValue => {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }

  const candidate = value as ProcessorStaticValue;
  switch (candidate.kind) {
    case 'class-name':
      return typeof candidate.className === 'string';
    case 'opaque-component':
      return (
        candidate.className === undefined ||
        typeof candidate.className === 'string'
      );
    case 'runtime-callback':
    case 'serializable':
      return true;
    case 'selector-chain':
      return (
        typeof candidate.className === 'string' &&
        Array.isArray(candidate.selectors) &&
        candidate.selectors.every((selector) => typeof selector === 'string')
      );
    case 'unresolved':
      return typeof candidate.reason === 'string';
    default:
      return false;
  }
};

export const getProcessorStaticValue = (
  processor: BaseProcessor
): ProcessorStaticValue | null => {
  if (!processor.getStaticValue) {
    return null;
  }

  try {
    const value = processor.getStaticValue(
      createProcessorStaticContext(processor)
    );
    return isProcessorStaticValue(value) ? value : null;
  } catch {
    return null;
  }
};

export const processorStaticValueToRuntimeValue = (
  value: ProcessorStaticValue
): unknown | UnknownProcessorStaticValue => {
  switch (value.kind) {
    case 'class-name':
      return value.value === undefined ? value.className : value.value;
    case 'opaque-component':
    case 'runtime-callback':
      return value.value === undefined
        ? unknownProcessorStaticValue
        : value.value;
    case 'selector-chain':
    case 'serializable':
      return value.value;
    case 'unresolved':
      return unknownProcessorStaticValue;
    default:
      return unknownProcessorStaticValue;
  }
};

export const resolveProcessorStaticRuntimeValue = (
  processor: BaseProcessor
): unknown | UnknownProcessorStaticValue => {
  const staticValue = getProcessorStaticValue(processor);
  return staticValue
    ? processorStaticValueToRuntimeValue(staticValue)
    : unknownProcessorStaticValue;
};

export const resolveProcessorStaticClassName = (
  processor: BaseProcessor
): string | null => {
  const staticValue = getProcessorStaticValue(processor);
  if (staticValue?.kind !== 'class-name') {
    return null;
  }

  const runtimeValue = processorStaticValueToRuntimeValue(staticValue);
  return typeof runtimeValue === 'string'
    ? runtimeValue
    : staticValue.className;
};

export const processorLiteralValue = (
  expression: ProcessorExpression
): unknown | UnknownProcessorStaticValue => {
  const expressionWithValue = expression as ProcessorExpression & {
    value?: unknown;
  };

  if (
    expression.type === 'StringLiteral' ||
    expression.type === 'NumericLiteral' ||
    expression.type === 'BooleanLiteral' ||
    expression.type === 'Literal'
  ) {
    return expressionWithValue.value;
  }

  if (expression.type === 'NullLiteral') {
    return null;
  }

  return unknownProcessorStaticValue;
};

export const processorPropertyKeyName = (
  key: ProcessorExpression
): string | null => {
  if (key.type === 'Identifier') {
    return (key as ProcessorExpression & { name: string }).name;
  }

  const value = processorLiteralValue(key);
  return typeof value === 'string' ? value : null;
};

export const processorObjectPropertyValue = (
  expression: ProcessorExpression,
  name: string
): ProcessorExpression | null => {
  if (expression.type !== 'ObjectExpression') {
    return null;
  }

  const { properties } = expression as ProcessorExpression & {
    properties?: Array<
      ProcessorExpression & {
        key?: ProcessorExpression;
        type: string;
        value?: ProcessorExpression;
      }
    >;
  };
  if (!properties) {
    return null;
  }

  for (const property of properties) {
    if (
      (property.type === 'ObjectProperty' || property.type === 'Property') &&
      property.key &&
      processorPropertyKeyName(property.key) === name
    ) {
      return property.value ?? null;
    }
  }

  return null;
};

export const processorExpressionToStaticValue = (
  expression: ProcessorExpression,
  resolveHelperCall: (name: string) => unknown | UnknownProcessorStaticValue
): unknown | UnknownProcessorStaticValue => {
  const literal = processorLiteralValue(expression);
  if (literal !== unknownProcessorStaticValue) {
    return literal;
  }

  if (expression.type === 'ArrayExpression') {
    const { elements } = expression as ProcessorExpression & {
      elements?: Array<ProcessorExpression | null>;
    };
    if (!elements) {
      return unknownProcessorStaticValue;
    }

    const result: unknown[] = [];
    for (const element of elements) {
      if (element === null) {
        result.push(null);
      } else {
        const value = processorExpressionToStaticValue(
          element,
          resolveHelperCall
        );
        if (value === unknownProcessorStaticValue) {
          return unknownProcessorStaticValue;
        }

        result.push(value);
      }
    }

    return result;
  }

  if (expression.type === 'ObjectExpression') {
    const metaExpression = processorObjectPropertyValue(
      expression,
      '__wyw_meta'
    );
    if (!metaExpression || metaExpression.type !== 'ObjectExpression') {
      return unknownProcessorStaticValue;
    }

    const classNameExpression = processorObjectPropertyValue(
      metaExpression,
      'className'
    );
    const className = classNameExpression
      ? processorLiteralValue(classNameExpression)
      : unknownProcessorStaticValue;
    if (typeof className !== 'string') {
      return unknownProcessorStaticValue;
    }

    const extendsExpression = processorObjectPropertyValue(
      metaExpression,
      'extends'
    );
    const extended = extendsExpression
      ? processorExpressionToStaticValue(extendsExpression, resolveHelperCall)
      : null;
    if (extended === unknownProcessorStaticValue) {
      return unknownProcessorStaticValue;
    }

    return {
      __wyw_meta: {
        className,
        extends: extended,
      },
    };
  }

  if (expression.type === 'CallExpression') {
    const call = expression as ProcessorExpression & {
      arguments?: ProcessorExpression[];
      callee?: ProcessorExpression;
    };
    if (call.arguments?.length === 0 && call.callee?.type === 'Identifier') {
      return resolveHelperCall(
        (call.callee as ProcessorExpression & { name: string }).name
      );
    }
  }

  return unknownProcessorStaticValue;
};
