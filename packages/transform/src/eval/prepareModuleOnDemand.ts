import { oxcShaker } from '../shaker';
import type { Services } from '../transform/types';
import { Entrypoint } from '../transform/Entrypoint';
import { prepareCodeForEvalRuntime } from '../transform/generators/transform';

export type PreparedModule = {
  code: string;
  imports: Map<string, string[]> | null;
  only: string[];
};

export function prepareModuleOnDemand(
  services: Services,
  id: string,
  only: string[]
): PreparedModule {
  const entrypoint = Entrypoint.createRoot(services, id, only, undefined);

  if (entrypoint.ignored) {
    return {
      code: entrypoint.loadedAndParsed.code ?? '',
      imports: null,
      only: entrypoint.only,
    };
  }

  const ast =
    entrypoint.loadedAndParsed.evaluator === oxcShaker
      ? null
      : (entrypoint.loadedAndParsed.ast as Parameters<
          typeof prepareCodeForEvalRuntime
        >[2]);
  const [code, imports] = prepareCodeForEvalRuntime(services, entrypoint, ast);

  return {
    code,
    imports,
    only: entrypoint.only,
  };
}
