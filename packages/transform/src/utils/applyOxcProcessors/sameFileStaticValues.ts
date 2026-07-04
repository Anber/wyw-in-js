/* eslint-disable no-restricted-syntax */

import type { BaseProcessor } from '@wyw-in-js/processor-utils';
import type { ExpressionValue } from '@wyw-in-js/shared';
import type { Node } from 'oxc-parser';

import { resolveDeclarativeProcessorStaticValue } from '../../processors/declarativeSemantics';
import type { OxcStaticValueCandidate } from '../collectOxcTemplateDependencies';
import { isOxcNode } from '../oxc/ast';
import {
  processorExpressionToStaticValue,
  resolveProcessorStaticRuntimeValue,
  processorStaticValueToRuntimeValue,
  type UnknownProcessorStaticValue,
  unknownProcessorStaticValue,
} from '../processorStaticSemantics';
import {
  GENERATED_HELPER_NAME_RE,
  JS_IDENTIFIER_RE,
  WYW_META_EXTENDS_HELPER_RE,
} from './shared';
import type { AnyNode, SameFileProcessorObject } from './types';

export const oxcLiteralValue = (
  expression: Node
): unknown | UnknownProcessorStaticValue => {
  const expressionWithValue = expression as Node & {
    value?: unknown;
  };
  const expressionType = expression.type as string;

  if (
    expressionType === 'StringLiteral' ||
    expressionType === 'NumericLiteral' ||
    expressionType === 'BooleanLiteral' ||
    expressionType === 'Literal'
  ) {
    return expressionWithValue.value;
  }

  if (expressionType === 'NullLiteral') {
    return null;
  }

  return unknownProcessorStaticValue;
};

export const oxcPropertyKeyName = (key: Node): string | null => {
  if (key.type === 'Identifier') {
    return (key as Node & { name: string }).name;
  }

  const value = oxcLiteralValue(key);
  return typeof value === 'string' ? value : null;
};

export const collectStaticObjectPropertyNames = (
  objectExpression: Node
): Set<string> | null => {
  if (objectExpression.type !== 'ObjectExpression') {
    return null;
  }

  const { properties } = objectExpression as Node & {
    properties?: Array<
      Node & {
        computed?: boolean;
        key?: Node;
        type: string;
        value?: Node;
      }
    >;
  };
  if (!properties) {
    return null;
  }

  const names = new Set<string>();
  for (const property of properties) {
    const propertyType = property.type as string;
    if (propertyType !== 'ObjectProperty' && propertyType !== 'Property') {
      return null;
    }

    if (!property.key || !property.value) {
      return null;
    }

    const name = oxcPropertyKeyName(property.key);
    if (!name || names.has(name)) {
      return null;
    }

    names.add(name);
  }

  return names;
};

export const getSameFileProcessorObjectProperty = (
  ancestors: Node[]
): {
  localName: string;
  propertyName: string;
  propertyNames: Set<string>;
} | null => {
  let propertyIndex = -1;
  for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
    if (ancestors[idx].type === 'Property') {
      propertyIndex = idx;
      break;
    }
  }

  if (propertyIndex <= 0) {
    return null;
  }

  const property = ancestors[propertyIndex] as Node & {
    key?: Node;
  };
  const objectExpression = ancestors[propertyIndex - 1];
  if (!property.key || objectExpression.type !== 'ObjectExpression') {
    return null;
  }

  const propertyName = oxcPropertyKeyName(property.key);
  const propertyNames = collectStaticObjectPropertyNames(objectExpression);
  if (!propertyName || !propertyNames) {
    return null;
  }

  for (let idx = propertyIndex - 2; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx] as AnyNode;
    if (ancestor.type === 'VariableDeclarator') {
      const { id, init } = ancestor;
      if (
        isOxcNode(id) &&
        id.type === 'Identifier' &&
        init === objectExpression
      ) {
        return {
          localName: id.name,
          propertyName,
          propertyNames,
        };
      }
    }
  }

  return null;
};

export const createSameFileProcessorStaticValueResolver = (
  processorsByLocal: Map<string, BaseProcessor>,
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[],
  staticValues: { name: string; value: unknown }[] = []
): {
  resolveLocal: (local: string) => unknown | UnknownProcessorStaticValue;
  resolveProcessor: (
    processor: BaseProcessor
  ) => unknown | UnknownProcessorStaticValue;
} => {
  const expressionSourceByName = new Map<string, string>();
  const staticValueByName = new Map<string, unknown>();
  expressionValues.forEach((value) => {
    if (value.ex.type === 'Identifier') {
      expressionSourceByName.set(value.ex.name, value.source);
    }
  });
  staticValues.forEach((value) => {
    staticValueByName.set(value.name, value.value);
  });

  const memo = new Map<string, unknown | UnknownProcessorStaticValue>();
  const resolving = new Set<string>();
  let resolveLocal: (
    local: string
  ) => unknown | UnknownProcessorStaticValue = () =>
    unknownProcessorStaticValue;

  function resolveExpressionValue(
    expression: Omit<ExpressionValue, 'buildCodeFrameError'>
  ): unknown | UnknownProcessorStaticValue {
    if ('value' in expression) {
      return expression.value;
    }

    if (expression.ex.type === 'Identifier') {
      const staticValue = staticValueByName.get(expression.ex.name);
      if (staticValueByName.has(expression.ex.name)) {
        return staticValue;
      }

      const source = expressionSourceByName.get(expression.ex.name);
      return source ? resolveLocal(source) : unknownProcessorStaticValue;
    }

    return unknownProcessorStaticValue;
  }

  function resolveDeclarativeProcessorRuntimeValue(
    processor: BaseProcessor,
    resolveInput: (
      expression: Omit<ExpressionValue, 'buildCodeFrameError'>
    ) => unknown | UnknownProcessorStaticValue
  ): unknown | null {
    const staticValue = resolveDeclarativeProcessorStaticValue(
      processor,
      (expression) => {
        const value = resolveInput(expression);
        return value === unknownProcessorStaticValue
          ? { resolved: false }
          : { resolved: true, value };
      }
    );
    if (!staticValue) {
      return null;
    }

    const runtimeValue = processorStaticValueToRuntimeValue(staticValue);
    return runtimeValue === unknownProcessorStaticValue ? null : runtimeValue;
  }

  resolveLocal = (local: string): unknown | UnknownProcessorStaticValue => {
    if (memo.has(local)) {
      return memo.get(local)!;
    }

    const processor = processorsByLocal.get(local);
    if (!processor || resolving.has(local)) {
      return unknownProcessorStaticValue;
    }

    resolving.add(local);
    const contractValue = resolveProcessorStaticRuntimeValue(processor);
    const value =
      contractValue !== unknownProcessorStaticValue
        ? contractValue
        : resolveDeclarativeProcessorRuntimeValue(
            processor,
            resolveExpressionValue
          ) ??
          processorExpressionToStaticValue(processor.value, (helperName) => {
            const source = expressionSourceByName.get(helperName);
            return source ? resolveLocal(source) : unknownProcessorStaticValue;
          });
    resolving.delete(local);
    memo.set(local, value);
    return value;
  };

  function resolveProcessor(
    processor: BaseProcessor
  ): unknown | UnknownProcessorStaticValue {
    const contractValue = resolveProcessorStaticRuntimeValue(processor);
    if (contractValue !== unknownProcessorStaticValue) {
      return contractValue;
    }

    const declarativeValue = resolveDeclarativeProcessorRuntimeValue(
      processor,
      resolveExpressionValue
    );
    if (declarativeValue !== null) {
      return declarativeValue;
    }

    return processorExpressionToStaticValue(processor.value, (helperName) => {
      const source = expressionSourceByName.get(helperName);
      return source ? resolveLocal(source) : unknownProcessorStaticValue;
    });
  }

  return { resolveLocal, resolveProcessor };
};

export const collectSameFileProcessorStaticValuesByLocal = (
  processorsByLocal: Map<string, BaseProcessor>,
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[],
  staticValues: { name: string; value: unknown }[] = []
): Map<string, unknown> => {
  const { resolveLocal } = createSameFileProcessorStaticValueResolver(
    processorsByLocal,
    expressionValues,
    staticValues
  );

  const result = new Map<string, unknown>();
  processorsByLocal.forEach((_processor, local) => {
    const value = resolveLocal(local);
    if (value !== unknownProcessorStaticValue) {
      result.set(local, value);
    }
  });

  return result;
};

export const collectSameFileProcessorObjectStaticValuesByLocal = (
  processorObjectsByLocal: Map<string, SameFileProcessorObject>,
  processorsByLocal: Map<string, BaseProcessor>,
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[],
  staticValues: { name: string; value: unknown }[] = []
): Map<string, unknown> => {
  const { resolveProcessor } = createSameFileProcessorStaticValueResolver(
    processorsByLocal,
    expressionValues,
    staticValues
  );

  const result = new Map<string, unknown>();
  for (const [local, object] of processorObjectsByLocal) {
    if (object.properties.size === object.propertyNames.size) {
      const value: Record<string, unknown> = {};
      let complete = true;
      for (const propertyName of object.propertyNames) {
        const processor = object.properties.get(propertyName);
        if (!processor) {
          complete = false;
          break;
        }

        const propertyValue = resolveProcessor(processor);
        if (propertyValue === unknownProcessorStaticValue) {
          complete = false;
          break;
        }

        value[propertyName] = propertyValue;
      }

      if (complete) {
        result.set(local, value);
      }
    }
  }

  return result;
};

export const collectWYWMetaExtendsHelperNames = (code: string): Set<string> => {
  const names = new Set<string>();

  let match = WYW_META_EXTENDS_HELPER_RE.exec(code);
  while (match) {
    const name = match[1];
    if (name && GENERATED_HELPER_NAME_RE.test(name)) {
      names.add(name);
    }
    match = WYW_META_EXTENDS_HELPER_RE.exec(code);
  }
  return names;
};

export const collectCandidateInlineConstants = (
  candidate: OxcStaticValueCandidate,
  processorStaticValuesByLocal: Map<string, unknown>
): Record<string, unknown> | null => {
  const inlineConstants: Record<string, unknown> = {};
  let hasInlineConstant = false;

  let match = JS_IDENTIFIER_RE.exec(candidate.source);
  while (match) {
    const name = match[0];
    if (processorStaticValuesByLocal.has(name)) {
      inlineConstants[name] = processorStaticValuesByLocal.get(name);
      hasInlineConstant = true;
    }
    match = JS_IDENTIFIER_RE.exec(candidate.source);
  }

  return hasInlineConstant ? inlineConstants : null;
};

export const addCandidateInlineConstants = (
  candidates: OxcStaticValueCandidate[],
  processorStaticValuesByLocal: Map<string, unknown>
): OxcStaticValueCandidate[] => {
  if (processorStaticValuesByLocal.size === 0) {
    return candidates;
  }

  return candidates.map((candidate) => {
    const inlineConstants = collectCandidateInlineConstants(
      candidate,
      processorStaticValuesByLocal
    );

    if (!inlineConstants) {
      return candidate;
    }

    return {
      ...candidate,
      inlineConstants: {
        ...candidate.inlineConstants,
        ...inlineConstants,
      },
    };
  });
};
