import { oxcShaker } from '../shaker';
import type { Services } from '../transform/types';
import { Entrypoint } from '../transform/Entrypoint';
import { collectOxcImportMap } from '../utils/oxcImportMap';
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
  const entrypoint = Entrypoint.createRoot(services, id, only, undefined, {
    mergeCachedOnly: !only.includes('__wywPreval'),
  });

  if (entrypoint.ignored) {
    const code = entrypoint.loadedAndParsed.code ?? '';
    // An ignored module is shipped verbatim, not shaken — its import and
    // re-export statements are still real dependency edges the runner's
    // linker will resolve, so the broker needs them for the same
    // `only`-merging reasons as a normal module (see collectOxcImportMap).
    // "Ignored" also covers genuinely non-JS content (CSS, assets) that
    // oxc's parser can't handle — a parse failure here must leave `imports`
    // at its previous, safe default rather than throwing.
    let imports: ReturnType<typeof collectOxcImportMap> | null = null;
    if (code) {
      try {
        imports = collectOxcImportMap(code, id);
      } catch {
        imports = null;
      }
    }

    return {
      code,
      imports,
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
