import type { IVariableContext } from '../IVariableContext';

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

export type EvaluatorOptions = {
  ast?: boolean | null;
  configFile?: boolean | null | string;
  env?: Record<string, EvaluatorOptions | null | undefined> | null;
  filename?: string | null;
  inputSourceMap?: object | null;
  overrides?: EvaluatorOptions[] | null;
  plugins?: unknown[] | null;
  presets?: unknown[] | null;
  root?: string | null;
  sourceFileName?: string | null;
  sourceMaps?: boolean | 'both' | 'inline' | null;
  [key: string]: unknown;
};

export type TransformEngineOptions = EvaluatorOptions;

export type EvaluatorAst = unknown;

export type EvaluatorRuntime = unknown;

export type Evaluator = (
  evalConfig: EvaluatorOptions,
  ast: EvaluatorAst,
  code: string,
  config: EvaluatorConfig,
  runtime: EvaluatorRuntime
) => [
  ast: EvaluatorAst,
  code: string,
  imports: Map<string, string[]> | null,
  exports?: string[] | null,
];

export type EvalRule = {
  action: Evaluator | 'ignore' | string;
  /**
   * Per-rule Oxc options for the Oxc-first transform path.
   */
  oxcOptions?: OxcOptions;
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
   * Controls behavior when an import reaches eval-time native resolver fallback.
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

export type EvalResolverMode = 'bundler' | 'hybrid' | 'native' | 'custom';

export type EvalRequireMode = 'warn-and-run' | 'error' | 'off';

export type EvalResolverKind = 'import' | 'dynamic-import' | 'require';

export type EvalWarningCode =
  | 'resolve-fallback'
  | 'resolve-error'
  | 'require-fallback'
  | 'require-error'
  | 'dynamic-import'
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
  /**
   * Default is `bundler`. `hybrid` is an opt-in mode whose intended
   * precedence is customResolver -> native Oxc resolver -> bundler.
   */
  resolver?: EvalResolverMode;
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
  staticImportValues: FeatureFlag;
  useWeakRefInEval: FeatureFlag;
};

export type FeatureFlags<
  TOnly extends keyof AllFeatureFlags = keyof AllFeatureFlags,
> = Pick<AllFeatureFlags, TOnly>;

export type CodeRemoverOptions = {
  componentTypes?: Record<string, string[]>;
  hocs?: Record<string, string[]>;
};

export type OxcOptions = {
  /**
   * Parser-level Oxc options. The first slice only preserves this contract.
   */
  parser?: Record<string, unknown>;
  /**
   * Resolver-level Oxc options. Bundler-aware resolution remains authoritative
   * unless `eval.resolver` explicitly opts into `hybrid`.
   */
  resolver?: Record<string, unknown>;
  /**
   * Transform-level Oxc options.
   */
  transform?: Record<string, unknown>;
};

export type StrictOptions = {
  classNameSlug?: string | ClassNameFn;
  codeRemover?: CodeRemoverOptions;
  conditionNames?: string[];
  displayName: boolean;
  evaluate: boolean;
  eval?: EvalOptionsV2;
  extensions: string[];
  features: FeatureFlags;
  highPriorityPlugins: string[];
  ignore?: RegExp;
  importLoaders?: ImportLoaders;
  importOverrides?: ImportOverrides;
  /**
   * Per-source map of imported names to statically-known values. Used by
   * the static evaluator when resolving imports from the listed sources.
   *
   * Each entry maps an import source (a package name or absolute file
   * path) to a record of imported names. Each name's value is either:
   *   - a function: treated as a pure helper. Called at every CallExpression
   *     site whose callee resolves to this binding, with evaluator-resolved
   *     args. Result is treated as a static value.
   *   - any other value: treated as a literal binding override. Returned
   *     wherever the binding is referenced.
   *
   * Trust model is the same as importOverrides / tagResolver: the user
   * vouches that pure helpers are deterministic and that literal
   * overrides reflect the runtime value (or knowingly diverge for
   * prototyping / SSR theming).
   *
   * Example:
   *   staticBindings: {
   *     '@linaria/core': {
   *       cx: (...args) => args.filter(Boolean).join(' '),
   *     },
   *     '/abs/path/to/theme.ts': {
   *       themeVars: { panelBg: '#f00' },
   *     },
   *   }
   */
  staticBindings?: Record<string, Record<string, unknown>>;
  outputMetadata: boolean;
  overrideContext?: (
    context: Partial<VmContext>,
    filename: string
  ) => Partial<VmContext>;
  /**
   * Oxc-first transform options.
   */
  oxcOptions: OxcOptions;
  rules: EvalRule[];
  tagResolver?: (
    source: string,
    tag: string,
    meta: TagResolverMeta
  ) => string | null;
  evalConsole?: 'warning' | 'pipe';
  variableNameConfig?: 'var' | 'dashes' | 'raw';
  variableNameSlug?: string | VariableNameFn;
};
