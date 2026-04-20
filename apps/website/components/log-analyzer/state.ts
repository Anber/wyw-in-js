import type { JsonlParseError, JsonlProgress } from './jsonl';
import type {
  ActionRecord,
  ActionsSummary,
  DependenciesStats,
  EntrypointFileStats,
  EntrypointInstance,
} from './types';

export type RequiredFileKey = 'actions' | 'dependencies' | 'entrypoints';

export type RequiredFiles = Partial<Record<RequiredFileKey, File>>;

export type ParseErrors = Record<RequiredFileKey, JsonlParseError[]>;

export type ParsedData = {
  actions: ActionRecord[];
  actionsSummary: ActionsSummary;
  dependencies: DependenciesStats;
  entrypointsFiles: EntrypointFileStats[];
  entrypointsInstances: EntrypointInstance[];
  pathPrefix: string;
  skippedLines: Record<RequiredFileKey, number>;
};

export type ParseProgress = {
  file: RequiredFileKey;
  progress: JsonlProgress;
};

export type TabId =
  | 'overview'
  | 'actions'
  | 'entrypoints'
  | 'dependencies'
  | 'help';
