export type SyntaxEngine = 'babel' | 'oxc';

export type SyntaxSourceLocation = {
  column: number;
  line: number;
};

export type SyntaxSourceRange = {
  end: SyntaxSourceLocation;
  start: SyntaxSourceLocation;
};

export type ParsedModule<TAst = unknown> = {
  ast: TAst;
  code: string;
  engine: SyntaxEngine;
  filename: string;
};

export type ModuleImport = {
  imported: string;
  source: string;
};

export type ModuleReexport = {
  exported: string;
  source: string;
};

export type ModuleAnalysis = {
  exports: readonly string[];
  imports: readonly ModuleImport[];
  reexports: readonly ModuleReexport[];
};

export type EmittedModule<TSourceMap = unknown> = {
  code: string;
  map?: TSourceMap | null;
};

export type SyntaxAdapter<
  TAst = unknown,
  TParseOptions = unknown,
  TEmitOptions = unknown,
> = {
  engine: SyntaxEngine;
  analyze(module: ParsedModule<TAst>): ModuleAnalysis;
  emit(module: ParsedModule<TAst>, options?: TEmitOptions): EmittedModule;
  parse(
    code: string,
    filename: string,
    options?: TParseOptions
  ): ParsedModule<TAst>;
};
