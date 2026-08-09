import type { CodeRemoverOptions } from '@wyw-in-js/shared';

import {
  applyReplacements,
  collectDangerousCodeReplacementsWithOxc,
  type Replacement,
} from './oxcPreevalTransforms';

export type DangerousCodePlan = {
  runtimeOnlyProcessorSpans: Array<Pick<Replacement, 'end' | 'start'>>;
  removedSpans: Array<Pick<Replacement, 'end' | 'start'>>;
  replacements: Replacement[];
};

export const createDangerousCodePlanWithOxc = (
  code: string,
  filename: string,
  options?: CodeRemoverOptions,
  planningOptions?: {
    ignoredSpans?: Array<Pick<Replacement, 'end' | 'start'>>;
    preserveImportMetaEnv?: boolean;
  }
): DangerousCodePlan => {
  const replacements = collectDangerousCodeReplacementsWithOxc(
    code,
    filename,
    options,
    planningOptions
  );

  return {
    removedSpans: replacements.map(({ end, start }) => ({ end, start })),
    replacements,
    runtimeOnlyProcessorSpans: replacements
      .filter((replacement) => replacement.kind === 'component')
      .map(({ end, start }) => ({ end, start })),
  };
};

export const removeDangerousCodeWithOxc = (
  code: string,
  filename: string,
  options?: CodeRemoverOptions
): string =>
  applyReplacements(
    code,
    createDangerousCodePlanWithOxc(code, filename, options).replacements
  );
