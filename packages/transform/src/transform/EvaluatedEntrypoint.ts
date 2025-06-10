import type { Debugger } from '@wyw-in-js/shared';

import { BaseEntrypoint } from './BaseEntrypoint';
import type { IEntrypointDependency } from './Entrypoint.types';

export interface IEvaluatedEntrypoint {
  dependencies: Map<string, IEntrypointDependency>;
  evaluated: true;
  evaluatedOnly: string[];
  exports: Record<string | symbol, unknown>;
  generation: number;
  ignored: false;
  log: Debugger;
  only: string[];
}

export class EvaluatedEntrypoint
  extends BaseEntrypoint
  implements IEvaluatedEntrypoint
{
  public readonly evaluated = true;

  public readonly ignored = false;
}
