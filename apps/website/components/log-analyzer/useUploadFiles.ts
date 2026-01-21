import * as React from 'react';

import { REQUIRED_FILENAMES } from './constants';
import { detectRequiredFiles } from './files';
import type { RequiredFiles } from './state';

export function useUploadFiles() {
  const [selected, setSelected] = React.useState<RequiredFiles>({});
  const [problems, setProblems] = React.useState<string[]>([]);
  const [inputsKey, setInputsKey] = React.useState(0);

  const onPickFiles = React.useCallback((files: File[]) => {
    const { required, problems: nextProblems } = detectRequiredFiles(files);
    setSelected(required);
    setProblems(nextProblems);
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      onPickFiles(Array.from(e.dataTransfer.files ?? []));
    },
    [onPickFiles]
  );

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
    onDrop,
    reset,
  };
}

export type UploadFilesState = ReturnType<typeof useUploadFiles>;
