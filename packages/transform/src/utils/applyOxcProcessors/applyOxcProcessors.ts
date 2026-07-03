import type { BaseProcessor, IFileContext } from '@wyw-in-js/processor-utils';
import type { ExpressionValue, StrictOptions } from '@wyw-in-js/shared';

import { collectOxcProcessorImportsFromProgram } from '../collectOxcExportsAndImports';
import { collectOxcExpressionDependencies } from '../collectOxcTemplateDependencies';
import { EventEmitter } from '../EventEmitter';
import type { AddedImport } from '../oxcAstService';
import { isOxcNode } from '../oxc/ast';
import { applyOxcReplacements } from '../oxc/replacements';
import {
  buildOxcCodeFrameError,
  createOxcLocationLookup,
} from '../oxc/sourceLocations';
import { getProcessorForImport } from '../../processors/processorLookup';
import { resolveProcessorStaticClassName } from '../processorStaticSemantics';
import { collectUsedNames } from './cleanupBindings';
import {
  addCandidateInlineConstants,
  collectSameFileProcessorObjectStaticValuesByLocal,
  collectSameFileProcessorStaticValuesByLocal,
  collectWYWMetaExtendsHelperNames,
  getSameFileProcessorObjectProperty,
} from './sameFileStaticValues';
import {
  collectSameFileProcessorStaticValues,
  getTagOwner,
  isTagReferenced,
} from './displayName';
import { buildParams } from './expressionValues';
import {
  createProcessor,
  shouldCollectStaticExpressionValues,
} from './processorFactory';
import {
  collectProcessorUsages,
  collectUsageExpressionSpans,
} from './processorUsages';
import { removeUnusedAfterReplacement } from './cleanupRemovals';
import { insertAddedImports, parseOxc } from './shared';
import type {
  ApplyOxcProcessorsResult,
  DefinedProcessor,
  Replacement,
  SameFileProcessorObject,
} from './types';

export const applyOxcProcessors = (
  code: string,
  fileContext: IFileContext,
  options: Pick<
    StrictOptions,
    | 'classNameSlug'
    | 'displayName'
    | 'eval'
    | 'extensions'
    | 'processors'
    | 'staticBindings'
    | 'tagResolver'
  > & {
    eventEmitter?: EventEmitter;
    preserveSideEffectImportOrderLocals?: Set<string>;
    preserveSideEffectImportLocals?: Set<string>;
  },
  callback: (processor: BaseProcessor) => void,
  cleanupUnused = false
): ApplyOxcProcessorsResult => {
  const filename = fileContext.filename ?? 'unknown.js';
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;
  const collectStaticExpressionValues =
    shouldCollectStaticExpressionValues(options);
  let workingCode = code;
  let program = parseOxc(workingCode, filename);
  const definedProcessors = new Map<string, DefinedProcessor>();
  const removableImportLocals = new Set<string>();
  const removableExpressionRefs = new Set<string>();

  eventEmitter.perf('transform:preeval:processTemplate:imports', () => {
    const imports = eventEmitter.perf(
      'transform:preeval:processTemplate:imports:analysis',
      () => collectOxcProcessorImportsFromProgram(program, workingCode)
    );

    eventEmitter.perf(
      'transform:preeval:processTemplate:imports:lookup',
      () => {
        imports.forEach((item) => {
          const localName = item.local.name ?? item.local.code;
          if (item.imported === 'side-effect' || !localName) {
            return;
          }

          const [processor, tagSource] = getProcessorForImport(
            {
              imported: item.imported,
              source: item.source,
            },
            filename,
            options
          );

          if (processor) {
            definedProcessors.set(localName, [processor, tagSource]);
            removableImportLocals.add(localName);
            const rootLocalName = localName.split('.')[0];
            if (rootLocalName) {
              removableImportLocals.add(rootLocalName);
            }
          }
        });
      }
    );
  });

  if (definedProcessors.size === 0) {
    return {
      code: workingCode,
      processorClassNamesByLocal: new Map(),
      processors: [],
      staticValueCandidates: [],
      staticValues: [],
    };
  }

  let processorUsages = eventEmitter.perf(
    'transform:preeval:processTemplate:usages',
    () => collectProcessorUsages(program, definedProcessors)
  );
  if (processorUsages.length === 0) {
    return {
      code: workingCode,
      processorClassNamesByLocal: new Map(),
      processors: [],
      staticValueCandidates: [],
      staticValues: [],
    };
  }

  const targetExpressionSpans = processorUsages.flatMap(
    collectUsageExpressionSpans
  );

  const extracted =
    targetExpressionSpans.length > 0
      ? eventEmitter.perf('transform:preeval:processTemplate:deps', () =>
          collectOxcExpressionDependencies(
            workingCode,
            filename,
            collectStaticExpressionValues,
            targetExpressionSpans,
            options.staticBindings
          )
        )
      : {
          code: workingCode,
          dependencyNames: [],
          expressionValues: [],
          staticValueCandidates: [],
          staticValues: [],
        };

  if (extracted.code !== workingCode) {
    workingCode = extracted.code;
    program = eventEmitter.perf(
      'transform:preeval:processTemplate:reparse',
      () => parseOxc(workingCode, filename)
    );
    processorUsages = eventEmitter.perf(
      'transform:preeval:processTemplate:usages',
      () => collectProcessorUsages(program, definedProcessors)
    );
  }

  const templateExpressionValues = extracted.expressionValues.map(
    (value) =>
      ({
        ...value,
        buildCodeFrameError: (message: string) =>
          buildOxcCodeFrameError(code, value.ex.loc!, message),
      }) as ExpressionValue
  );
  const loc = createOxcLocationLookup(workingCode);
  const usedNames = eventEmitter.perf(
    'transform:preeval:processTemplate:usedNames',
    () => collectUsedNames(program)
  );
  const addedImports: AddedImport[] = [];
  const replacements: Replacement[] = [];
  const processors: BaseProcessor[] = [];
  const processorClassNamesByLocal = new Map<string, string>();
  const sameFileProcessorsByLocal = new Map<string, BaseProcessor>();
  const sameFileProcessorObjectsByLocal = new Map<
    string,
    SameFileProcessorObject
  >();
  extracted.dependencyNames.forEach((name: string) =>
    removableImportLocals.add(name)
  );

  eventEmitter.perf('transform:preeval:processTemplate:processors', () => {
    processorUsages.forEach((usage, idx) => {
      const params = buildParams(
        usage,
        workingCode,
        loc,
        filename,
        templateExpressionValues,
        usage.collapseQualifiedCallee
      );
      if (!params) {
        return;
      }

      const created = createProcessor(
        usage.definedProcessor,
        params,
        usage.target,
        usage.replacementTarget,
        usage.ancestors,
        fileContext,
        options,
        workingCode,
        loc,
        idx,
        isTagReferenced(program, usage.ancestors),
        usedNames,
        replacements
      );

      if (!created) {
        return;
      }

      const { astService, processor } = created;

      const owner = getTagOwner(usage.ancestors);
      if (owner?.type === 'VariableDeclarator') {
        const { id } = owner;
        if (isOxcNode(id) && id.type === 'Identifier') {
          removableExpressionRefs.add(id.name);
          sameFileProcessorsByLocal.set(id.name, processor);
          // Cross-file map (used as a className-only fallback in
          // resolveStaticExport) is restricted to processors whose
          // runtime value IS the className string. Styled-component
          // bindings emit a richer value and must reach consumers via
          // resolveProcessorStaticExport so composition still works.
          const staticClassName = resolveProcessorStaticClassName(processor);
          if (staticClassName) {
            processorClassNamesByLocal.set(id.name, staticClassName);
          } else {
            const replacement = processor.value as {
              type?: string;
              value?: unknown;
            };
            if (
              (replacement?.type === 'StringLiteral' ||
                replacement?.type === 'Literal') &&
              typeof replacement.value === 'string'
            ) {
              processorClassNamesByLocal.set(id.name, processor.className);
            }
          }
        }
      }

      const objectProperty = getSameFileProcessorObjectProperty(
        usage.ancestors
      );
      if (objectProperty) {
        const existing = sameFileProcessorObjectsByLocal.get(
          objectProperty.localName
        );
        const object = existing ?? {
          properties: new Map<string, BaseProcessor>(),
          propertyNames: objectProperty.propertyNames,
        };

        object.properties.set(objectProperty.propertyName, processor);
        sameFileProcessorObjectsByLocal.set(objectProperty.localName, object);
      }

      processors.push(processor);
      callback(processor);
      addedImports.push(...astService.getAddedImports());
    });
  });
  const sameFileProcessorStaticValuesByLocal =
    collectSameFileProcessorStaticValuesByLocal(
      sameFileProcessorsByLocal,
      extracted.expressionValues
    );
  const sameFileProcessorObjectStaticValuesByLocal =
    collectSameFileProcessorObjectStaticValuesByLocal(
      sameFileProcessorObjectsByLocal,
      sameFileProcessorsByLocal,
      extracted.expressionValues
    );
  sameFileProcessorObjectStaticValuesByLocal.forEach((value, local) => {
    sameFileProcessorStaticValuesByLocal.set(local, value);
  });

  const replacedCode = applyOxcReplacements(workingCode, replacements);
  const metadataExtendsHelperNames =
    collectWYWMetaExtendsHelperNames(replacedCode);
  const staticValueCandidates = extracted.staticValueCandidates.filter(
    (candidate) =>
      candidate.imports.length > 0 ||
      !metadataExtendsHelperNames.has(candidate.name)
  );
  const sameFileProcessorStaticValues = collectSameFileProcessorStaticValues(
    extracted.expressionValues,
    sameFileProcessorStaticValuesByLocal
  );
  const codeWithAddedImports = insertAddedImports(
    replacedCode,
    program,
    addedImports
  );

  return {
    code: cleanupUnused
      ? eventEmitter.perf('transform:preeval:processTemplate:cleanup', () =>
          removeUnusedAfterReplacement(
            codeWithAddedImports,
            filename,
            removableImportLocals,
            new Set([...removableExpressionRefs, ...extracted.dependencyNames]),
            options.preserveSideEffectImportLocals ?? new Set(),
            options.preserveSideEffectImportOrderLocals ??
              options.preserveSideEffectImportLocals ??
              new Set()
          )
        )
      : codeWithAddedImports,
    processorClassNamesByLocal,
    processors,
    staticValueCandidates: addCandidateInlineConstants(
      staticValueCandidates,
      sameFileProcessorStaticValuesByLocal
    ),
    staticValues: [...extracted.staticValues, ...sameFileProcessorStaticValues],
  };
};
