/**
 * This file is an entry point for module evaluation for getting lazy dependencies.
 */

import { invariant } from 'ts-invariant';

import type { Entrypoint } from '../transform/Entrypoint';
import type { Services } from '../transform/types';

export interface IEvaluateResult {
  dependencies: string[];
  values: Map<string, unknown> | null;
}

export default async function evaluate(
  services: Services,
  entrypoint: Entrypoint
): Promise<IEvaluateResult> {
  invariant(
    services.evalBroker,
    '[wyw-in-js] Eval broker is missing for evaluation.'
  );
  const result = await services.evalBroker.evaluate(entrypoint);

  return {
    values: result.values,
    dependencies: result.dependencies,
  };
}
