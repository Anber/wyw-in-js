import type { Location } from '@wyw-in-js/shared';

export type SourceLocation = {
  end: Location;
  filename?: string;
  identifierName?: string | null;
  start: Location;
};

export type BaseAstNode = {
  end?: number | null;
  loc?: unknown;
  start?: number | null;
  type: string;
};

export type Expression = BaseAstNode;

export type Identifier = Expression & {
  name: string;
  type: 'Identifier';
};

export type StringLiteral = Expression & {
  type: 'StringLiteral';
  value: string;
};

export type NumericLiteral = Expression & {
  type: 'NumericLiteral';
  value: number;
};

export type BooleanLiteral = Expression & {
  type: 'BooleanLiteral';
  value: boolean;
};

export type NullLiteral = Expression & {
  type: 'NullLiteral';
};

export type BlockStatement = BaseAstNode & {
  body: BaseAstNode[];
  type: 'BlockStatement';
};

export type TemplateElement = BaseAstNode & {
  loc?: SourceLocation | null;
  tail: boolean;
  type: 'TemplateElement';
  value: {
    cooked?: string | null;
    raw: string;
  };
};

export type MemberExpression = Expression & {
  computed?: boolean;
  object: Expression;
  property: Expression;
  type: 'MemberExpression';
};

export type ObjectProperty = BaseAstNode & {
  computed?: boolean;
  key: Expression;
  shorthand?: boolean;
  type: 'ObjectProperty';
  value: Expression;
};

export type ObjectExpression = Expression & {
  properties: ObjectProperty[];
  type: 'ObjectExpression';
};

export type ArrayExpression = Expression & {
  elements: (Expression | null)[];
  type: 'ArrayExpression';
};

export type CallExpression = Expression & {
  arguments: Expression[];
  callee: Expression;
  type: 'CallExpression';
};

export type ArrowFunctionExpression = Expression & {
  async?: boolean;
  body: BlockStatement | Expression;
  params: Identifier[];
  type: 'ArrowFunctionExpression';
};

export type AstService = {
  addDefaultImport(source: string, nameHint?: string): Identifier;
  addNamedImport(name: string, source: string, nameHint?: string): Identifier;
  arrayExpression(elements: (Expression | null)[]): ArrayExpression;
  arrowFunctionExpression(
    params: Identifier[],
    body: BlockStatement | Expression
  ): ArrowFunctionExpression;
  blockStatement(body: BaseAstNode[]): BlockStatement;
  booleanLiteral(value: boolean): BooleanLiteral;
  callExpression(callee: Expression, args: Expression[]): CallExpression;
  identifier(name: string): Identifier;
  memberExpression(
    object: Expression,
    property: Expression,
    computed?: boolean
  ): MemberExpression;
  nullLiteral(): NullLiteral;
  numericLiteral(value: number): NumericLiteral;
  objectExpression(properties: ObjectProperty[]): ObjectExpression;
  objectProperty(key: Expression, value: Expression): ObjectProperty;
  stringLiteral(value: string): StringLiteral;
};

type PrintContext = {
  indent: number;
  quote?: 'double' | 'single';
};

const stringLiteralCode = (
  value: string,
  quote: 'double' | 'single' = 'double'
): string => {
  const json = JSON.stringify(value);
  if (quote === 'double') {
    return json;
  }

  return `'${json.slice(1, -1).replace(/'/g, "\\'")}'`;
};

const indent = (level: number): string => '  '.repeat(level);

const expressionToCodeWithContext = (
  expression: Expression,
  context: PrintContext
): string => {
  if (expression.type === 'Identifier') {
    return (expression as Identifier).name;
  }

  if (expression.type === 'StringLiteral') {
    return stringLiteralCode(
      (expression as StringLiteral).value,
      context.quote
    );
  }

  if (
    expression.type === 'NumericLiteral' ||
    expression.type === 'BooleanLiteral'
  ) {
    return String((expression as NumericLiteral | BooleanLiteral).value);
  }

  if (expression.type === 'NullLiteral') {
    return 'null';
  }

  if (expression.type === 'MemberExpression') {
    const memberExpression = expression as MemberExpression;
    const object = expressionToCodeWithContext(
      memberExpression.object,
      context
    );
    const property = expressionToCodeWithContext(
      memberExpression.property,
      context
    );
    return memberExpression.computed
      ? `${object}[${property}]`
      : `${object}.${property}`;
  }

  if (expression.type === 'CallExpression') {
    const callExpression = expression as CallExpression;
    const callee = expressionToCodeWithContext(callExpression.callee, context);
    const args = callExpression.arguments.map((arg) =>
      expressionToCodeWithContext(arg, {
        ...context,
        quote: arg.type === 'StringLiteral' ? 'single' : context.quote,
      })
    );

    return `${callee}(${args.join(', ')})`;
  }

  if (expression.type === 'ArrowFunctionExpression') {
    const arrow = expression as ArrowFunctionExpression;
    return `(${arrow.params
      .map((param) => expressionToCodeWithContext(param, context))
      .join(', ')}) => ${expressionToCodeWithContext(arrow.body, context)}`;
  }

  if (expression.type === 'ArrayExpression') {
    return `[${(expression as ArrayExpression).elements
      .map((item) => (item ? expressionToCodeWithContext(item, context) : ''))
      .join(', ')}]`;
  }

  if (expression.type === 'BlockStatement') {
    return '{ }';
  }

  if (expression.type === 'ObjectExpression') {
    const objectExpression = expression as ObjectExpression;
    if (objectExpression.properties.length === 0) {
      return '{}';
    }

    const nextIndent = context.indent + 1;
    const properties = objectExpression.properties
      .map((property) => {
        const key = expressionToCodeWithContext(property.key, {
          ...context,
          quote: 'double',
        });
        const value = expressionToCodeWithContext(property.value, {
          indent: nextIndent,
          quote: 'double',
        });
        return `${indent(nextIndent)}${key}: ${value}`;
      })
      .join(',\n');

    return `{\n${properties}\n${indent(context.indent)}}`;
  }

  return expression.type;
};

export const expressionToCode = (expression: Expression): string =>
  expressionToCodeWithContext(expression, {
    indent: 0,
    quote: 'double',
  });
