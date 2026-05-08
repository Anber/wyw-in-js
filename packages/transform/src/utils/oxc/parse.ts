import type { Program } from 'oxc-parser';

import { parseOxcProgramCached } from '../parseOxc';

export type OxcSourceType = 'module' | 'unambiguous';

export const parseOxcProgram = (
  code: string,
  filename: string,
  sourceType: OxcSourceType = 'unambiguous'
): Program => parseOxcProgramCached(filename, code, sourceType);
