import type {
  CallExpression,
  Expression,
  MemberExpression,
  Node,
  Program,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import type {
  CallExpressionLike,
  DefinedProcessor,
  ExpressionSpan,
  OxcIdentifier,
  ProcessorUsage,
  QualifiedExpression,
  SequenceExpressionLike,
} from './types';

export const getMemberName = (node: MemberExpression): string | null => {
  if (node.computed) {
    return node.property.type === 'Literal' &&
      typeof node.property.value === 'string'
      ? node.property.value
      : null;
  }

  return node.property.type === 'Identifier' ? node.property.name : null;
};

export const unwrapQualifiedExpression = (node: Expression): Expression => {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return unwrapQualifiedExpression(
      (node as QualifiedExpression & { expression: Expression }).expression
    );
  }

  if (node.type === 'SequenceExpression') {
    const sequence = node as SequenceExpressionLike;
    return unwrapQualifiedExpression(
      sequence.expressions[sequence.expressions.length - 1] ?? node
    );
  }

  return node;
};

export const getRootIdentifier = (node: Expression): OxcIdentifier | null => {
  const expression = unwrapQualifiedExpression(node);

  if (expression.type === 'Identifier') {
    return expression;
  }

  if (expression.type === 'MemberExpression') {
    return getRootIdentifier(expression.object);
  }

  if (expression.type === 'CallExpression') {
    return getRootIdentifier((expression as CallExpressionLike).callee);
  }

  return null;
};

export const getQualifiedName = (node: Expression): string | null => {
  const expression = unwrapQualifiedExpression(node);

  if (expression.type === 'Identifier') {
    return expression.name;
  }

  if (expression.type === 'MemberExpression') {
    const object = getQualifiedName(expression.object);
    const member = getMemberName(expression);
    return object && member ? `${object}.${member}` : null;
  }

  if (expression.type === 'CallExpression') {
    return getQualifiedName((expression as CallExpressionLike).callee);
  }

  return null;
};

export const resolveDefinedProcessor = (
  callee: Expression,
  definedProcessors: Map<string, DefinedProcessor>
): {
  collapseQualifiedCallee: boolean;
  definedProcessor: DefinedProcessor;
} | null => {
  const qualified = getQualifiedName(callee);
  if (qualified) {
    const definedProcessor = definedProcessors.get(qualified);
    if (definedProcessor) {
      return {
        collapseQualifiedCallee: qualified.includes('.'),
        definedProcessor,
      };
    }
  }

  const root = getRootIdentifier(callee);
  if (!root) {
    return null;
  }

  const definedProcessor = definedProcessors.get(root.name);
  return definedProcessor
    ? {
        collapseQualifiedCallee: false,
        definedProcessor,
      }
    : null;
};

export const isCallTagOfTaggedTemplate = (
  node: Node,
  parent: Node | null
): boolean =>
  parent?.type === 'TaggedTemplateExpression' && parent.tag === node;

export const expandReplacementTarget = (
  target: Expression,
  ancestors: Node[]
): Expression => {
  let current: Expression = target;

  for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx];
    if (
      ancestor.type === 'SequenceExpression' &&
      ancestor.expressions[ancestor.expressions.length - 1] === current
    ) {
      current = ancestor as Expression;
    } else if (
      ancestor.type === 'ParenthesizedExpression' &&
      ancestor.expression === current
    ) {
      current = ancestor as Expression;
    } else {
      break;
    }
  }

  return current;
};

export const collectProcessorUsages = (
  program: Program,
  definedProcessors: Map<string, DefinedProcessor>
): ProcessorUsage[] => {
  const usages: ProcessorUsage[] = [];

  const walk = (
    node: Node,
    ancestors: Node[],
    parent: Node | null = null
  ): void => {
    if (node.type === 'TaggedTemplateExpression') {
      const callee = node.tag as Expression;
      const resolvedProcessor = resolveDefinedProcessor(
        callee,
        definedProcessors
      );
      if (resolvedProcessor) {
        usages.push({
          ancestors,
          callee,
          collapseQualifiedCallee: resolvedProcessor.collapseQualifiedCallee,
          definedProcessor: resolvedProcessor.definedProcessor,
          kind: 'template',
          replacementTarget: expandReplacementTarget(node, ancestors),
          target: node,
        });
      }
    } else if (
      node.type === 'CallExpression' &&
      !isCallTagOfTaggedTemplate(node, parent)
    ) {
      const { callee } = node as CallExpressionLike;
      const resolvedProcessor = resolveDefinedProcessor(
        callee,
        definedProcessors
      );
      if (resolvedProcessor) {
        usages.push({
          ancestors,
          callee,
          collapseQualifiedCallee: resolvedProcessor.collapseQualifiedCallee,
          definedProcessor: resolvedProcessor.definedProcessor,
          kind: 'call',
          replacementTarget: expandReplacementTarget(
            node as CallExpression,
            ancestors
          ),
          target: node as CallExpression,
        });
      }
    }

    getOxcNodeChildren(node).forEach((child) =>
      walk(child, [...ancestors, node], node)
    );
  };

  walk(program, []);

  return usages.sort((a, b) => a.target.start - b.target.start);
};

export const expressionSpan = (expression: Expression): ExpressionSpan => ({
  end: expression.end,
  start: expression.start,
});

export const collectCallArgumentSpans = (
  node: Expression
): ExpressionSpan[] => {
  const expression = unwrapQualifiedExpression(node);

  if (expression.type === 'CallExpression') {
    const call = expression as CallExpressionLike;
    const calleeSpans = collectCallArgumentSpans(call.callee);
    const argumentSpans = call.arguments.flatMap((arg) =>
      arg.type === 'SpreadElement' ? [] : [expressionSpan(arg as Expression)]
    );
    return [...calleeSpans, ...argumentSpans];
  }

  if (expression.type === 'MemberExpression') {
    return collectCallArgumentSpans(expression.object);
  }

  return [];
};

export const collectUsageExpressionSpans = (
  usage: ProcessorUsage
): ExpressionSpan[] => {
  const calleeSpans = collectCallArgumentSpans(usage.callee);
  if (usage.kind === 'template') {
    return [
      ...calleeSpans,
      ...usage.target.quasi.expressions.map((expression) =>
        expressionSpan(expression as Expression)
      ),
    ];
  }

  return [
    ...calleeSpans,
    ...usage.target.arguments.flatMap((arg) =>
      arg.type === 'SpreadElement' ? [] : [expressionSpan(arg as Expression)]
    ),
  ];
};
