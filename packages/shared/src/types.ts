export type Artifact = [name: string, data: unknown];

export type BuildCodeFrameErrorFn = <TError extends Error>(
  msg: string,
  Error?: new (innerMsg: string) => TError
) => TError;

export enum ValueType {
  LAZY,
  FUNCTION,
  CONST,
}

export type SourceLocation = {
  end: Location;
  filename?: string;
  identifierName?: string | null;
  start: Location;
};

export type AstNode = {
  end?: number | null;
  loc?: SourceLocation | null;
  start?: number | null;
  type: string;
};

export type AstExpression = AstNode;

export type Identifier = AstExpression & {
  name: string;
  type: 'Identifier';
};

export type StringLiteral = AstExpression & {
  type: 'StringLiteral';
  value: string;
};

export type NumericLiteral = AstExpression & {
  type: 'NumericLiteral';
  value: number;
};

export type NullLiteral = AstExpression & {
  type: 'NullLiteral';
};

export type BooleanLiteral = AstExpression & {
  type: 'BooleanLiteral';
  value: boolean;
};

export type BigIntLiteral = AstExpression & {
  type: 'BigIntLiteral';
  value: bigint | string;
};

export type DecimalLiteral = AstExpression & {
  type: 'DecimalLiteral';
  value: string;
};

export type LazyValue = {
  buildCodeFrameError: BuildCodeFrameErrorFn;
  ex: Identifier;
  importedFrom?: string[];
  kind: ValueType.LAZY;
  source: string;
};

export type FunctionValue = {
  buildCodeFrameError: BuildCodeFrameErrorFn;
  ex: Identifier;
  importedFrom?: string[];
  kind: ValueType.FUNCTION;
  source: string;
};

export type ConstValue = {
  buildCodeFrameError: BuildCodeFrameErrorFn;
  ex:
    | StringLiteral
    | NumericLiteral
    | NullLiteral
    | BooleanLiteral
    | BigIntLiteral
    | DecimalLiteral;
  kind: ValueType.CONST;
  source: string;
  value: string | number | boolean | null;
};

export type ExpressionValue = LazyValue | FunctionValue | ConstValue;

export type WYWEvalMeta = {
  __wyw_meta: {
    className: string;
    extends: WYWEvalMeta;
  };
};

export type Location = {
  column: number;
  line: number;
};

export type Replacement = {
  length: number;
  original: { end: Location; start: Location };
};

export type Replacements = Array<Replacement>;

/**
 * CSS-related types
 */

export interface ICSSRule {
  atom?: boolean;
  className: string;
  cssText: string;
  displayName: string;
  start: Location | null | undefined;
}

export type Rules = Record<string, ICSSRule>;
