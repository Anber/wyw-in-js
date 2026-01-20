export type ActionsStartLine = {
  actionId: number;
  entrypointRef: string;
  idx: string;
  startedAt: number;
  type: string;
};

export type ActionsFinishLine = {
  actionId: number;
  error?: unknown;
  finishedAt: number;
  isAsync: boolean;
  result: 'failed' | 'finished';
};

export type ActionLine = ActionsStartLine | ActionsFinishLine;

export type ActionRecord = {
  actionId: number;
  type: string;
  entrypointRef: string;
  entrypointFilename?: string;
  actionIdx: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  isAsync: boolean;
  result: 'failed' | 'finished';
  error?: unknown;
};

export type EntrypointCreatedEvent = {
  class: string;
  evaluatedOnly: string[];
  filename: string;
  generation: number;
  idx: string;
  isExportsInherited: boolean;
  only: string[];
  parentId: number | null;
  type: 'created';
};

export type EntrypointSupersededEvent = {
  type: 'superseded';
  with: number;
};

export type EntrypointActionCreatedEvent = {
  actionIdx: string;
  actionType: string;
  type: 'actionCreated';
};

export type EntrypointSetTransformResultEvent = {
  isNull: boolean;
  type: 'setTransformResult';
};

export type EntrypointEvent =
  | EntrypointCreatedEvent
  | EntrypointSupersededEvent
  | EntrypointActionCreatedEvent
  | EntrypointSetTransformResultEvent;

export type EntrypointLine = [number, number, EntrypointEvent];

export type EntrypointInstance = {
  seqId: number;
  createdAt?: number;
  ref?: string;
  filename?: string;
  idx?: string;
  generation?: number;
  onlyLen?: number;
  parentId?: number | null;
  supersededAt?: number;
  supersededWith?: number;
};

export type EntrypointFileStats = {
  filename: string;
  createdCount: number;
  supersededCount: number;
  onlyMin: number | null;
  onlyMax: number | null;
};

export type DependenciesLine = {
  file: string;
  fileIdx: string;
  imports: { from: string; what: string[] }[];
  only: string[];
  type?: string;
};

export type ImportStats = {
  from: string;
  count: number;
  importers: string[];
};

export type PackageStats = {
  name: string;
  count: number;
};

export type DependenciesStats = {
  files: string[];
  filesCount: number;
  importsCount: number;
  topImports: ImportStats[];
  topPackages: PackageStats[];
  importersByFrom: Map<string, Set<string>>;
};

export type ActionsSummary = {
  spanMs: number;
  startedAt: number | null;
  finishedAt: number | null;
  totalActions: number;
  finishedActions: number;
  failedActions: number;
  asyncActions: number;
  topTypesByInclusiveMs: Array<[string, number]>;
  topTypesByExclusiveMs: Array<[string, number]>;
};
