import type { Program } from 'oxc-parser';

export type ImportKind = 'cjs' | 'dynamic' | 'esm';

export type OxcLocal = {
  code: string;
  end: number;
  name?: string;
  start: number;
};

export type OxcCollectedImport = {
  imported: string | 'default' | '*' | 'side-effect';
  local: OxcLocal;
  source: string;
  type: ImportKind;
};

export type OxcCollectedExport = {
  exported: string | 'default' | '*';
  local: OxcLocal;
};

export type OxcCollectedReexport = {
  exported: string | 'default' | '*';
  imported: string | 'default' | '*';
  local: OxcLocal;
  source: string;
};

export type OxcCollectedState = {
  deadExports: string[];
  exports: Record<string | 'default' | '*', OxcLocal>;
  imports: OxcCollectedImport[];
  isEsModule: boolean;
  reexports: OxcCollectedReexport[];
};

type FullCollectionCacheEntry = {
  code: string;
  isEsModule: boolean;
  result: OxcCollectedState;
};

type ProcessorImportsCacheEntry = {
  code: string;
  result: OxcCollectedImport[];
};

type ProgramCollectionCache = {
  full?: FullCollectionCacheEntry;
  processorImports?: ProcessorImportsCacheEntry;
};

// Parsed Programs are reused across transform actions. Keep cached results
// private because the public return types intentionally remain mutable.
const collectionByProgram = new WeakMap<Program, ProgramCollectionCache>();

const snapshotImports = (
  imports: readonly OxcCollectedImport[]
): OxcCollectedImport[] =>
  imports.map((item) => ({
    ...item,
    local: { ...item.local },
  }));

const snapshotState = (state: OxcCollectedState): OxcCollectedState => ({
  deadExports: [...state.deadExports],
  exports: Object.fromEntries(
    Object.entries(state.exports).map(([exported, local]) => [
      exported,
      { ...local },
    ])
  ),
  imports: snapshotImports(state.imports),
  isEsModule: state.isEsModule,
  reexports: state.reexports.map((item) => ({
    ...item,
    local: { ...item.local },
  })),
});

export const getCachedOxcCollection = (
  program: Program,
  code: string,
  isEsModule: boolean
): OxcCollectedState | null => {
  const cached = collectionByProgram.get(program)?.full;
  return cached?.code === code && cached.isEsModule === isEsModule
    ? snapshotState(cached.result)
    : null;
};

export const cacheOxcCollection = (
  program: Program,
  code: string,
  isEsModule: boolean,
  result: OxcCollectedState
): OxcCollectedState => {
  const cached = collectionByProgram.get(program) ?? {};
  cached.full = { code, isEsModule, result };
  collectionByProgram.set(program, cached);
  return snapshotState(result);
};

export const getCachedOxcProcessorImports = (
  program: Program,
  code: string
): OxcCollectedImport[] | null => {
  const cached = collectionByProgram.get(program)?.processorImports;
  return cached?.code === code ? snapshotImports(cached.result) : null;
};

export const cacheOxcProcessorImports = (
  program: Program,
  code: string,
  result: OxcCollectedImport[]
): OxcCollectedImport[] => {
  const cached = collectionByProgram.get(program) ?? {};
  cached.processorImports = { code, result };
  collectionByProgram.set(program, cached);
  return snapshotImports(result);
};
