import type { JsonlParseError, JsonlProgress } from './jsonl';
import type {
  ActionRecord,
  ActionsSummary,
  DependenciesStats,
  EvalFilesStats,
  EntrypointFileStats,
  EntrypointInstance,
} from './types';

export type RequiredFileKey = 'actions' | 'dependencies' | 'entrypoints';

export type OptionalFileKey = 'evalFiles';

export type FileKey = RequiredFileKey | OptionalFileKey;

export type SelectedFiles = Partial<Record<FileKey, File>>;

export type RequiredFiles = Partial<Record<RequiredFileKey, File>>;

export type ParseErrors = Partial<Record<FileKey, JsonlParseError[]>>;

export type ParsedData = {
  actions: ActionRecord[];
  actionsSummary: ActionsSummary;
  dependencies: DependenciesStats;
  evalFiles?: EvalFilesStats;
  entrypointsFiles: EntrypointFileStats[];
  entrypointsInstances: EntrypointInstance[];
  pathPrefix: string;
  skippedLines: Record<FileKey, number>;
};

export type ParseProgress = {
  file: FileKey;
  progress: JsonlProgress;
};

export type TabId =
  | 'overview'
  | 'actions'
  | 'evalFiles'
  | 'entrypoints'
  | 'dependencies'
  | 'help';
