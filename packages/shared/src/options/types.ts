import type { TransformOptions } from '@babel/core';
import type { File } from '@babel/types';

import type { IVariableContext } from '../IVariableContext';
import type { Core } from '../babel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VmContext = Record<string, any>; // It's Context from `vm`

export type ClassNameSlugVars = {
  dir: string;
  ext: string;
  file: string;
  hash: string;
  index: number;
  name: string;
  title: string;
};

export type ClassNameFn = (
  hash: string,
  title: string,
  args: ClassNameSlugVars
) => string;

export type VariableNameFn = (context: IVariableContext) => string;

export type EvaluatorConfig = {
  features: StrictOptions['features'];
  highPriorityPlugins: string[];
  importOverrides?: StrictOptions['importOverrides'];
  onlyExports: string[];
  root?: string;
};

export type Evaluator = (
  evalConfig: TransformOptions,
  ast: File,
  code: string,
  config: EvaluatorConfig,
  babel: Core
) => [
  ast: File,
  code: string,
  imports: Map<string, string[]> | null,
  exports?: string[] | null,
];

export type EvalRule = {
  action: Evaluator | 'ignore' | string;
  babelOptions?: TransformOptions;
  test?: RegExp | ((path: string, code: string) => boolean);
};

export type FeatureFlag = boolean | string | string[];

type ImportOverrideMock = {
  /**
   * Replaces resolved import with provided specifier (resolved on prepare/eval stages).
   * Raw `source` stays intact; only resolution target changes.
   */
  mock: string;
  noShake?: never;
  unknown?: never;
};

type ImportOverrideNoShake = {
  mock?: never;
  /**
   * Disables tree-shaking for this import by forcing `only=['*']`.
   */
  noShake: true;
  unknown?: never;
};

type ImportOverrideUnknown = {
  mock?: never;
  noShake?: never;
  /**
   * Controls behavior when an import reaches eval-time Node resolver fallback.
   * - 'warn' (default): warn once per canonical import key.
   * - 'error': throw.
   * - 'allow': no warning, keep load-as-is.
   */
  unknown: 'allow' | 'error' | 'warn';
};

export type ImportOverride =
  | ImportOverrideMock
  | ImportOverrideNoShake
  | ImportOverrideUnknown;

export type ImportOverrides = Record<string, ImportOverride>;

export type ImportLoaderContext = {
  emitWarning: (message: string) => void;
  filename: string;
  hash: string;
  importer: string;
  query: string;
  readFile: () => string;
  request: string;
  resolved: string;
  toUrl: () => string;
};

export type ImportLoader =
  | 'raw'
  | 'url'
  | ((context: ImportLoaderContext) => unknown);

export type ImportLoaders = Record<string, ImportLoader | false>;

export type EvalResolverMode = 'bundler' | 'node' | 'custom';

export type EvalRequireMode = 'warn-and-run' | 'error' | 'off';

export type EvalResolverKind = 'import' | 'dynamic-import' | 'require';

export type EvalWarningCode =
  | 'resolve-fallback'
  | 'resolve-error'
  | 'require-fallback'
  | 'require-error'
  | 'eval-error';

export type EvalWarning = {
  code: EvalWarningCode;
  message: string;
  importer?: string;
  specifier?: string;
  resolved?: string | null;
  callstack?: string[];
  hint?: string;
};

export type EvalOptionsV2 = {
  resolver?: EvalResolverMode; // default: 'bundler'
  customResolver?: (
    specifier: string,
    importer: string,
    kind: EvalResolverKind
  ) => Promise<{ id: string; external?: boolean } | null>;
  customLoader?: (
    id: string
  ) => Promise<{ code: string; map?: unknown; loader?: string } | null>;
  require?: EvalRequireMode; // default: 'warn-and-run'
  mode?: 'strict' | 'loose'; // default: 'strict'
  globals?: Record<string, unknown>;
  onWarn?: (warning: EvalWarning) => void;
};

export type TagResolverMeta = {
  resolvedSource?: string;
  sourceFile: string | null | undefined;
};

type AllFeatureFlags = {
  dangerousCodeRemover: FeatureFlag;
  globalCache: FeatureFlag;
  happyDOM: FeatureFlag;
  softErrors: FeatureFlag;
  useBabelConfigs: FeatureFlag;
  useWeakRefInEval: FeatureFlag;
};

export type FeatureFlags<
  TOnly extends keyof AllFeatureFlags = keyof AllFeatureFlags,
> = Pick<AllFeatureFlags, TOnly>;

export type CodeRemoverOptions = {
  componentTypes?: Record<string, string[]>;
  hocs?: Record<string, string[]>;
};

export type StrictOptions = {
  babelOptions: TransformOptions;
  classNameSlug?: string | ClassNameFn;
  codeRemover?: CodeRemoverOptions;
  displayName: boolean;
  evaluate: boolean;
  eval?: EvalOptionsV2;
  extensions: string[];
  features: FeatureFlags;
  highPriorityPlugins: string[];
  ignore?: RegExp;
  importLoaders?: ImportLoaders;
  importOverrides?: ImportOverrides;
  overrideContext?: (
    context: Partial<VmContext>,
    filename: string
  ) => Partial<VmContext>;
  rules: EvalRule[];
  tagResolver?: (
    source: string,
    tag: string,
    meta: TagResolverMeta
  ) => string | null;
  variableNameConfig?: 'var' | 'dashes' | 'raw';
  variableNameSlug?: string | VariableNameFn;
};
