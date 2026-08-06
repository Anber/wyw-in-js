import type { CodeRemoverOptions } from '@wyw-in-js/shared';

import {
  applyReplacements,
  collectDangerousCodeReplacementsWithOxc,
  type Replacement,
} from './oxcPreevalTransforms';

export const collectDangerousCodeRemovalSpansWithOxc = (
  code: string,
  filename: string,
  options?: CodeRemoverOptions
): Array<Pick<Replacement, 'end' | 'start'>> =>
  collectDangerousCodeReplacementsWithOxc(code, filename, options).map(
    ({ end, start }) => ({ end, start })
  );

export const removeDangerousCodeWithOxc = (
  code: string,
  filename: string,
  options?: CodeRemoverOptions
): string =>
  applyReplacements(
    code,
    collectDangerousCodeReplacementsWithOxc(code, filename, options)
  );
