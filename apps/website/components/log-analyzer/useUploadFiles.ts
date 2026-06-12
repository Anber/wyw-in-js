import * as React from 'react';

import { REQUIRED_FILENAMES } from './constants';
import { detectRequiredFiles } from './files';
import type { SelectedFiles } from './state';

export function useUploadFiles() {
  const [selected, setSelected] = React.useState<SelectedFiles>({});
  const [problems, setProblems] = React.useState<string[]>([]);
  const [inputsKey, setInputsKey] = React.useState(0);

  const onPickFiles = React.useCallback((files: File[]) => {
    const { selected: nextSelected, problems: nextProblems } =
      detectRequiredFiles(files);
    setSelected(nextSelected);
    setProblems(nextProblems);
  }, []);

  const canParse = REQUIRED_FILENAMES.every((k) => selected[k]);

  const reset = React.useCallback(() => {
    setInputsKey((prev) => prev + 1);
    setSelected({});
    setProblems([]);
  }, []);

  return {
    selected,
    problems,
    inputsKey,
    canParse,
    onPickFiles,
    reset,
  };
}

export type UploadFilesState = ReturnType<typeof useUploadFiles>;
