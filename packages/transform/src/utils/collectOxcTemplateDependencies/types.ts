import type { ExpressionValue, ValueType } from '@wyw-in-js/shared';
import type {
  AssignmentExpression,
  Expression,
  Node,
  TemplateLiteral,
  UpdateExpression,
  VariableDeclaration,
  VariableDeclarator,
} from 'oxc-parser';

import type { OxcValueReplacement } from '../oxc/replacements';
import type { OxcLocationLookup } from '../oxc/sourceLocations';

export type OxcFunctionLikeNode = Node & {
  async: boolean;
  body: Node | null;
  id?: { name: string } | null;
  params: Node[];
};
export type BindingKind = 'function' | 'import' | 'param' | 'variable';
export type ScopedDeclarationKind = 'const' | 'let' | 'var';

export type Binding = {
  declarationKind?: ScopedDeclarationKind;
  declaredAt: number;
  declaration: VariableDeclaration | null;
  declarator: VariableDeclarator | null;
  functionNode?: OxcFunctionLikeNode | null;
  imported?: 'default' | '*' | string;
  importedFrom?: string;
  isRoot: boolean;
  kind: BindingKind;
  name: string;
  scope: Scope;
};

export type Replacement = OxcValueReplacement;

export type SpanLookup = Set<string> | null;

export type LocationLookup = OxcLocationLookup;

export type ExpressionSpan = {
  end: number;
  start: number;
};

export type Scope = {
  bindings: Map<string, Binding>;
  depth: number;
  end: number;
  functionBoundary: boolean;
  params: Set<string>;
  parent: Scope | null;
  root: boolean;
  start: number;
};

export type ReferenceIdentifier = {
  end: number;
  name: string;
  start: number;
};

export type OxcStaticImportReference = {
  imported: 'default' | string;
  importLocal?: string;
  local: string;
  source: string;
};

export type OxcStaticValue = {
  name: string;
  value: unknown;
};

export type OxcStaticValueCandidate = {
  imports: OxcStaticImportReference[];
  inlineConstants?: Record<string, unknown>;
  name: string;
  source: string;
};

export type TemplateExtractionResult = {
  code: string;
  dependencyNames: string[];
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
};

export type StaticBindings = Record<string, Record<string, unknown>>;

export type ExtractedExpression = {
  expressionCode: string;
  hasInlinableLocalReference?: boolean;
  importedFrom: string[];
  kind: ValueType.FUNCTION | ValueType.LAZY;
  staticExpressionCode?: string;
  staticImports: OxcStaticImportReference[];
  staticValue?: unknown;
};

export type StaticLocalExpression = {
  importedFrom: string[];
  imports: OxcStaticImportReference[];
  source: string;
};

export type ProgramAnalysis = {
  bindingsByName: Map<string, Binding[]>;
  rootMutationsByBinding: Map<
    string,
    Array<AssignmentExpression | UpdateExpression>
  >;
  targetExpressions: Expression[];
  templateLiterals: TemplateLiteral[];
  usedNames: Set<string>;
};

export type ExtractionContext = {
  bindingResolutionCache: Map<string, Map<number, Binding | null>>;
  bindingsByName: Map<string, Binding[]>;
  code: string;
  currentInsertionPoint: number;
  currentExpressionStart: number;
  dependencyNames: Set<string>;
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
  filename: string;
  hoistedBindingNames: Map<string, string>;
  hoistedDeclarations: Map<string, string>;
  hoistedDeclarationsByInsertionPoint: Map<number, string[]>;
  loc: LocationLookup;
  processorManagedExpressionSpans: Set<string>;
  referencesByNode: WeakMap<Node, ReferenceIdentifier[]>;
  replacements: Replacement[];
  rootMutationsByBinding: Map<
    string,
    Array<AssignmentExpression | UpdateExpression>
  >;
  staticBindings?: StaticBindings;
  staticImportAliases: Map<string, string>;
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
  usedNames: Set<string>;
};
