import type { Param, Params, SourceLocation } from '@wyw-in-js/processor-utils';
import type { ExpressionValue } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type { Expression, TaggedTemplateExpression } from 'oxc-parser';

import { isNotNull } from '../isNotNull';
import { buildOxcCodeFrameError } from '../oxc/sourceLocations';
import { getMemberName, unwrapQualifiedExpression } from './processorUsages';
import { GENERATED_HELPER_NAME_RE, getSourceLocation } from './shared';
import type {
  CallExpressionLike,
  LocationLookup,
  ProcessorUsage,
} from './types';

export const literalExpressionValue = (
  expression: Expression,
  code: string,
  source: string,
  location: SourceLocation
): ExpressionValue | null => {
  if (expression.type !== 'Literal') {
    return null;
  }

  if (
    expression.value === null ||
    typeof expression.value === 'string' ||
    typeof expression.value === 'number' ||
    typeof expression.value === 'boolean'
  ) {
    let type:
      | 'BooleanLiteral'
      | 'NullLiteral'
      | 'NumericLiteral'
      | 'StringLiteral';
    if (expression.value === null) {
      type = 'NullLiteral';
    } else if (typeof expression.value === 'string') {
      type = 'StringLiteral';
    } else if (typeof expression.value === 'number') {
      type = 'NumericLiteral';
    } else {
      type = 'BooleanLiteral';
    }

    const ex =
      expression.value === null
        ? { loc: location, type }
        : {
            loc: location,
            type,
            value: expression.value,
          };

    return {
      buildCodeFrameError: (message: string) =>
        buildOxcCodeFrameError(code, location, message),
      ex,
      kind: ValueType.CONST,
      source,
      value: expression.value,
    } as ExpressionValue;
  }

  return null;
};

export const expressionValue = (
  expression: Expression,
  code: string,
  loc: LocationLookup,
  filename?: string | null
): ExpressionValue => {
  const source = code.slice(expression.start, expression.end);
  const location = getSourceLocation(
    expression.start,
    expression.end,
    loc,
    filename
  );
  const literal = literalExpressionValue(expression, code, source, location);
  if (literal) {
    return literal;
  }

  const helperCallName =
    expression.type === 'CallExpression' &&
    expression.arguments.length === 0 &&
    expression.callee.type === 'Identifier' &&
    GENERATED_HELPER_NAME_RE.test(expression.callee.name)
      ? expression.callee.name
      : null;

  let ex: ExpressionValue['ex'];
  if (expression.type === 'Identifier') {
    ex = { loc: location, name: expression.name, type: 'Identifier' };
  } else if (helperCallName) {
    ex = { loc: location, name: helperCallName, type: 'Identifier' };
  } else {
    ex = {
      loc: location,
      name: code.slice(expression.start, expression.end),
      type: 'Identifier',
    };
  }

  return {
    buildCodeFrameError: (message: string) =>
      buildOxcCodeFrameError(code, location, message),
    ex,
    kind:
      expression.type === 'ArrowFunctionExpression' ||
      expression.type === 'FunctionExpression'
        ? ValueType.FUNCTION
        : ValueType.LAZY,
    source,
  } as ExpressionValue;
};

export const withCurrentExpressionLocation = (
  value: ExpressionValue,
  expression: Expression,
  loc: LocationLookup,
  filename?: string | null
): ExpressionValue => {
  const location = getSourceLocation(
    expression.start,
    expression.end,
    loc,
    filename
  );

  if (value.kind === ValueType.CONST) {
    return {
      ...value,
      ex: {
        ...value.ex,
        loc: location,
      },
    };
  }

  if (value.kind === ValueType.FUNCTION) {
    return {
      ...value,
      ex: {
        ...value.ex,
        loc: location,
      },
    };
  }

  return {
    ...value,
    ex: {
      ...value.ex,
      loc: location,
    },
  };
};

export const shiftExpressionValue = (
  expressionValues: ExpressionValue[],
  expression: Expression,
  code: string,
  loc: LocationLookup,
  filename?: string | null
): ExpressionValue =>
  expressionValues.length > 0
    ? withCurrentExpressionLocation(
        expressionValues.shift()!,
        expression,
        loc,
        filename
      )
    : expressionValue(expression, code, loc, filename);

export const zipTemplate = (
  template: TaggedTemplateExpression,
  code: string,
  loc: LocationLookup,
  filename: string | null | undefined,
  expressionValues: ExpressionValue[]
): Param => {
  const parts = template.quasi.quasis.flatMap((quasi, idx) => {
    const expression = template.quasi.expressions[idx];
    const templateElement = {
      ...quasi,
      loc: getSourceLocation(quasi.start, quasi.end, loc, filename),
    };

    return [
      templateElement,
      expression
        ? shiftExpressionValue(
            expressionValues,
            expression as Expression,
            code,
            loc,
            filename
          )
        : null,
    ].filter(isNotNull);
  });

  return ['template', parts] as Param;
};

export const buildCalleeParams = (
  node: Expression,
  code: string,
  loc: LocationLookup,
  filename: string | null | undefined,
  expressionValues: ExpressionValue[],
  collapseQualifiedCallee = false
): Params | null => {
  const expression = unwrapQualifiedExpression(node);

  if (
    collapseQualifiedCallee &&
    (expression.type === 'Identifier' || expression.type === 'MemberExpression')
  ) {
    return [['callee', expression] as Param];
  }

  if (expression.type === 'Identifier') {
    return [['callee', { name: expression.name, type: 'Identifier' }]];
  }

  if (expression.type === 'MemberExpression') {
    const params = buildCalleeParams(
      expression.object,
      code,
      loc,
      filename,
      expressionValues,
      collapseQualifiedCallee
    );
    const member = getMemberName(expression);
    return params && member ? [...params, ['member', member]] : null;
  }

  if (expression.type === 'CallExpression') {
    const call = expression as CallExpressionLike;
    const params = buildCalleeParams(
      call.callee,
      code,
      loc,
      filename,
      expressionValues,
      collapseQualifiedCallee
    );
    if (!params) {
      return null;
    }

    const callValues = call.arguments
      .filter((arg) => arg.type !== 'SpreadElement')
      .map((arg) =>
        shiftExpressionValue(
          expressionValues,
          arg as Expression,
          code,
          loc,
          filename
        )
      );

    return [...params, ['call', ...callValues]];
  }

  return null;
};

export const buildParams = (
  usage: ProcessorUsage,
  code: string,
  loc: LocationLookup,
  filename: string | null | undefined,
  expressionValues: ExpressionValue[],
  collapseQualifiedCallee: boolean
): Params | null => {
  const params = buildCalleeParams(
    usage.callee,
    code,
    loc,
    filename,
    expressionValues,
    collapseQualifiedCallee
  );
  if (!params) {
    return null;
  }

  if (usage.kind === 'template') {
    return [
      ...params,
      zipTemplate(usage.target, code, loc, filename, expressionValues),
    ];
  }

  const callValues = usage.target.arguments
    .filter((arg) => arg.type !== 'SpreadElement')
    .map((arg) =>
      shiftExpressionValue(
        expressionValues,
        arg as Expression,
        code,
        loc,
        filename
      )
    );

  return [...params, ['call', ...callValues]];
};
