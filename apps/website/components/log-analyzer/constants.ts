import type { RequiredFileKey } from './state';

export const REQUIRED_FILENAMES: RequiredFileKey[] = [
  'actions',
  'dependencies',
  'entrypoints',
];

export const FILE_NAME_BY_KEY: Record<RequiredFileKey, string> = {
  actions: 'actions.jsonl',
  dependencies: 'dependencies.jsonl',
  entrypoints: 'entrypoints.jsonl',
};
