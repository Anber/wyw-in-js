import type { File } from '@babel/types';

import type { Services } from '../transform/types';
import { Entrypoint } from '../transform/Entrypoint';
import { prepareCode } from '../transform/generators/transform';

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

  const ast = entrypoint.loadedAndParsed.ast as File;
  const [code, imports] = prepareCode(services, entrypoint, ast);

  return {
    code,
    imports,
    only: entrypoint.only,
  };
}
