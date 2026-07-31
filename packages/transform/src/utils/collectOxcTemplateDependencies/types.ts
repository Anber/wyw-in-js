import type { ExpressionValue, ValueType } from '@wyw-in-js/shared';
import type {
  AssignmentExpression,
  Expression,
  Node,
  Program,
  TemplateLiteral,
  UpdateExpression,
  VariableDeclaration,
  VariableDeclarator,
} from 'oxc-parser';

import type { OxcValueReplacement } from '../oxc/replacements';
import type { OxcFunctionLike } from '../oxc/runtimeSemantics';
import type { OxcLocationLookup } from '../oxc/sourceLocations';
import type { RecursiveProofState } from './recursiveProof';

export type OxcFunctionLikeNode = OxcFunctionLike;
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
  isIteration?: boolean;
  isRoot: boolean;
  kind: BindingKind;
  name: string;
  scope: Scope;
};

export type BindingIndex = {
  bindingsByName: ReadonlyMap<string, readonly Binding[]>;
  referenceScopesByStart: ReadonlyMap<number, Scope>;
};

export type Replacement = OxcValueReplacement;

export type SpanLookup = Set<string> | null;

export type LocationLookup = OxcLocationLookup;

export type ExpressionSpan = {
  end: number;
  start: number;
};

export type MutationSpan = Pick<Node, 'end' | 'start'>;

export type MutationTimeline<T extends MutationSpan = Node> = {
  readonly byEnd: readonly T[];
  readonly byStart: readonly T[];
};

export type MutationTimelineMap<T extends MutationSpan = Node> = ReadonlyMap<
  string,
  MutationTimeline<T>
>;

export type MutationTimelineLookup<T extends MutationSpan = Node> = Pick<
  MutationTimelineMap<T>,
  'get' | 'size'
>;

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
  bindingIndex: BindingIndex;
  rootMutationHazardsByBinding: MutationTimelineMap;
  rootMutationsByBinding: MutationTimelineMap<
    AssignmentExpression | UpdateExpression
  >;
  targetExpressions: Expression[];
  templateLiterals: TemplateLiteral[];
  usedNames: Set<string>;
};

export type ExtractionContext = {
  bindingIndex: BindingIndex;
  bindingResolutionCache: Map<string, Map<number, Binding | null>>;
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
  program: Program;
  referencesByNode: WeakMap<Node, ReferenceIdentifier[]>;
  replacements: Replacement[];
  rootMutationHazardsByBinding: MutationTimelineLookup;
  rootMutationsByBinding: MutationTimelineMap<
    AssignmentExpression | UpdateExpression
  >;
  staticBindings?: StaticBindings;
  staticImportAliases: Map<string, string>;
  staticCallProof: RecursiveProofState<Node>;
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
  usedNames: Set<string>;
};
