import generate from '@babel/generator';
import type { ExportAllDeclaration, File, Node } from '@babel/types';

import type { Core } from '../../babel';
import type { IExplodeReexportsAction, SyncScenarioForAction } from '../types';

import { findExportsInImports } from './getExports';

const getWildcardReexport = (babel: Core, ast: File) => {
  const reexportsFrom: { node: ExportAllDeclaration; source: string }[] = [];
  ast.program.body.forEach((node) => {
    if (
      babel.types.isExportAllDeclaration(node) &&
      node.source &&
      babel.types.isStringLiteral(node.source)
    ) {
      reexportsFrom.push({
        source: node.source.value,
        node,
      });
    }
  });

  return reexportsFrom;
};

/**
 * Replaces wildcard reexports with named reexports.
 * Recursively emits getExports for each reexported module,
 * and replaces wildcard with resolved named.
 */
export function* explodeReexports(
  this: IExplodeReexportsAction
): SyncScenarioForAction<IExplodeReexportsAction> {
  const { babel } = this.services;
  const { log, loadedAndParsed } = this.entrypoint;
  if (loadedAndParsed.evaluator === 'ignored') {
    return;
  }

  const reexportsFrom = getWildcardReexport(babel, loadedAndParsed.ast);
  if (!reexportsFrom.length) {
    return;
  }

  log('has wildcard reexport from %o', reexportsFrom);

  const resolvedImports = yield* this.getNext(
    'resolveImports',
    this.entrypoint,
    {
      imports: new Map(reexportsFrom.map((i) => [i.source, []])),
    }
  );

  const importedEntrypoints = findExportsInImports(
    this.entrypoint,
    resolvedImports
  );

  const replacements = new Map<ExportAllDeclaration, Node>();
  for (const importedEntrypoint of importedEntrypoints) {
    if (importedEntrypoint.entrypoint.loadedAndParsed.evaluator !== 'ignored') {
      const reexport = reexportsFrom.find(
        (i) => i.source === importedEntrypoint.import
      );
      if (reexport) {
        const exports = yield* this.getNext(
          'getExports',
          importedEntrypoint.entrypoint,
          undefined
        );

        const namedExports = exports.filter((name) => name !== 'default');
        if (namedExports.length !== 0) {
          replacements.set(
            reexport.node,
            babel.types.exportNamedDeclaration(
              null,
              namedExports.map((i) =>
                babel.types.exportSpecifier(
                  babel.types.identifier(i),
                  babel.types.identifier(i)
                )
              ),
              babel.types.stringLiteral(importedEntrypoint.import)
            )
          );
        }
      }
    }
  }

  // Replace wildcard reexport with named reexports
  babel.traverse(loadedAndParsed.ast, {
    ExportAllDeclaration(path) {
      if (!replacements.has(path.node)) return;
      path.replaceWith(replacements.get(path.node)!);
    },
  });

  loadedAndParsed.code = generate(loadedAndParsed.ast).code;
}
