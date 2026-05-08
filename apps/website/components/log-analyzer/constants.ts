import type { FileKey, OptionalFileKey, RequiredFileKey } from './state';

export const REQUIRED_FILENAMES: RequiredFileKey[] = [
  'actions',
  'dependencies',
  'entrypoints',
];

export const OPTIONAL_FILENAMES: OptionalFileKey[] = ['evalFiles'];

export const FILE_NAME_BY_KEY: Record<FileKey, string> = {
  actions: 'actions.jsonl',
  dependencies: 'dependencies.jsonl',
  entrypoints: 'entrypoints.jsonl',
  evalFiles: 'eval-files.jsonl',
};
