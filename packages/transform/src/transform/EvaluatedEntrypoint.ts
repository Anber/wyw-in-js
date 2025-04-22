import type { Debugger } from '@wyw-in-js/shared';

import { BaseEntrypoint } from './BaseEntrypoint';
import { IEntrypointDependency } from './Entrypoint.types';

export interface IEvaluatedEntrypoint {
  evaluated: true;
  evaluatedOnly: string[];
  exports: Record<string | symbol, unknown>;
  generation: number;
  ignored: false;
  log: Debugger;
  only: string[];
  dependencies: Map<string, IEntrypointDependency>;
}

export class EvaluatedEntrypoint
  extends BaseEntrypoint
  implements IEvaluatedEntrypoint
{
  public readonly evaluated = true;

  public readonly ignored = false;
}
