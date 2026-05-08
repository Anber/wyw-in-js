/* eslint-disable no-restricted-syntax */

import type {
  BaseProcessor,
  Expression as ProcessorExpression,
} from '@wyw-in-js/processor-utils';
import type { ExpressionValue } from '@wyw-in-js/shared';
import type { Node } from 'oxc-parser';

import type { OxcStaticValueCandidate } from '../collectOxcTemplateDependencies';
import { isOxcNode } from '../oxc/ast';
import {
  GENERATED_HELPER_NAME_RE,
  JS_IDENTIFIER_RE,
  WYW_META_EXTENDS_HELPER_RE,
} from './shared';
import type { AnyNode, SameFileProcessorObject } from './types';

export const unknownProcessorStaticValue = Symbol(
  'unknownProcessorStaticValue'
);

type UnknownProcessorStaticValue = typeof unknownProcessorStaticValue;

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

export const createSameFileProcessorStaticValueResolver = (
  processorsByLocal: Map<string, BaseProcessor>,
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[]
): {
  resolveLocal: (local: string) => unknown | UnknownProcessorStaticValue;
  resolveProcessor: (
    processor: BaseProcessor
  ) => unknown | UnknownProcessorStaticValue;
} => {
  const expressionSourceByName = new Map<string, string>();
  expressionValues.forEach((value) => {
    if (value.ex.type === 'Identifier') {
      expressionSourceByName.set(value.ex.name, value.source);
    }
  });

  const memo = new Map<string, unknown | UnknownProcessorStaticValue>();
  const resolving = new Set<string>();

  function resolveLocal(local: string): unknown | UnknownProcessorStaticValue {
    if (memo.has(local)) {
      return memo.get(local)!;
    }

    const processor = processorsByLocal.get(local);
    if (!processor || resolving.has(local)) {
      return unknownProcessorStaticValue;
    }

    resolving.add(local);
    const value = processorExpressionToStaticValue(
      processor.value,
      (helperName) => {
        const source = expressionSourceByName.get(helperName);
        return source ? resolveLocal(source) : unknownProcessorStaticValue;
      }
    );
    resolving.delete(local);
    memo.set(local, value);
    return value;
  }

  function resolveProcessor(
    processor: BaseProcessor
  ): unknown | UnknownProcessorStaticValue {
    return processorExpressionToStaticValue(processor.value, (helperName) => {
      const source = expressionSourceByName.get(helperName);
      return source ? resolveLocal(source) : unknownProcessorStaticValue;
    });
  }

  return { resolveLocal, resolveProcessor };
};

export const collectSameFileProcessorStaticValuesByLocal = (
  processorsByLocal: Map<string, BaseProcessor>,
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[]
): Map<string, unknown> => {
  const { resolveLocal } = createSameFileProcessorStaticValueResolver(
    processorsByLocal,
    expressionValues
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
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[]
): Map<string, unknown> => {
  const { resolveProcessor } = createSameFileProcessorStaticValueResolver(
    processorsByLocal,
    expressionValues
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
