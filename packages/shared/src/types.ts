import type {
  BigIntLiteral,
  BooleanLiteral,
  DecimalLiteral,
  Identifier,
  NullLiteral,
  NumericLiteral,
  StringLiteral,
} from '@babel/types';

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
