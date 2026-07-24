import type { ProcessorStaticValue } from '@wyw-in-js/processor-utils';
import type { StrictOptions } from '@wyw-in-js/shared';

import type { DeclarativeProcessorSemantics } from '../../processors/declarativeSemantics';
import { normalizeDeclarativeProcessorSemantics } from '../../processors/declarativeSemantics';
import { getProcessorForImport } from '../../processors/processorLookup';
import { collectOxcProcessorImportsFromProgram } from '../../utils/collectOxcExportsAndImports';
import {
  collectOxcExpressionDependencies,
  type StaticBindings,
} from '../../utils/collectOxcTemplateDependencies';
import type { EventEmitter } from '../../utils/EventEmitter';
import { isProcessorStaticValue } from '../../utils/processorStaticSemantics';
import type { IPreevalResult } from '../Entrypoint.types';
import { getDisplayName } from '../../utils/applyOxcProcessors/displayName';
import {
  collectProcessorUsages,
  collectUsageExpressionSpans,
  getRootIdentifier,
} from '../../utils/applyOxcProcessors/processorUsages';
import { parseOxc } from '../../utils/applyOxcProcessors/shared';
import type {
  DefinedProcessor,
  ProcessorUsage,
} from '../../utils/applyOxcProcessors/types';

import type {
  ProcessorUsagePlan,
  StaticEnv,
  StaticNeed,
  StaticPlan,
} from './types';
import {
  planStaticNeedRequests,
  resolveUnmetStaticNeeds,
} from './resolveStaticNeeds';

export type StaticPlanProcessorImport = {
  imported: string;
  local: string;
  semantics?: DeclarativeProcessorSemantics | null;
  source: string;
};

export type BuildStaticPlanInput = {
  code: string;
  filename: string;
  options?: Pick<
    StrictOptions,
    'processors' | 'staticBindings' | 'tagResolver'
  >;
  preparedImports?: Map<string, string[]> | null;
  preevalResult?: Pick<
    IPreevalResult,
    | 'dependencyNames'
    | 'runtimeOnlyStaticValueNames'
    | 'staticDependencies'
    | 'staticValueCache'
  >;
  processorImports?: StaticPlanProcessorImport[];
  staticBindings?: StaticBindings;
};

const PLAN_ONLY_PROCESSOR =
  class StaticPlanOnlyProcessor {} as unknown as DefinedProcessor[0];

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

const toProcessorStaticValue = (value: unknown): ProcessorStaticValue =>
  isProcessorStaticValue(value) ? value : { kind: 'serializable', value };

const discoverProcessorImports = ({
  code,
  filename,
  options,
}: Pick<
  BuildStaticPlanInput,
  'code' | 'filename' | 'options'
>): StaticPlanProcessorImport[] => {
  const program = parseOxc(code, filename);
  const imports = collectOxcProcessorImportsFromProgram(program, code);
  const processorImports: StaticPlanProcessorImport[] = [];

  imports.forEach((item) => {
    const local = item.local.name ?? item.local.code;
    if (item.imported === 'side-effect' || !local) {
      return;
    }

    const [processor, tagSource, manifest] = getProcessorForImport(
      {
        imported: item.imported,
        source: item.source,
      },
      filename,
      options ?? {}
    );

    // Only imports that resolve to an actual processor implementation (or a
    // processor manifest) may contribute plan usages. `tagSource` is returned
    // for every lookup, so checking it would turn every import of every
    // module into a phantom processor local.
    if (!processor && !manifest) {
      return;
    }

    processorImports.push({
      imported: tagSource.imported,
      local,
      semantics: normalizeDeclarativeProcessorSemantics(
        manifest?.semantics,
        manifest?.dir
      ),
      source: tagSource.source,
    });
  });

  return processorImports;
};

const collectRuntimeDependencies = (
  preparedImports: Map<string, string[]> | null | undefined,
  preevalResult: BuildStaticPlanInput['preevalResult']
): Set<string> => {
  const dependencies = new Set<string>();

  preparedImports?.forEach((_imports, source) => {
    dependencies.add(source);
  });
  preevalResult?.staticDependencies?.forEach((dependency) => {
    dependencies.add(dependency);
  });

  return dependencies;
};

const createDefinedProcessors = (
  processorImports: StaticPlanProcessorImport[]
): Map<string, DefinedProcessor> => {
  const definedProcessors = new Map<string, DefinedProcessor>();

  processorImports.forEach((item) => {
    definedProcessors.set(item.local, [
      PLAN_ONLY_PROCESSOR,
      {
        imported: item.imported,
        source: item.source,
      },
      {
        declarativeSemantics: item.semantics ?? null,
      },
    ]);
  });

  return definedProcessors;
};

const getUsageLocal = (usage: ProcessorUsage): string => {
  const root = getRootIdentifier(usage.callee);
  return root?.name ?? usage.definedProcessor[1].imported;
};

const toProcessorUsagePlan = (
  usage: ProcessorUsage,
  idx: number,
  code: string,
  filename: string,
  staticValueNames: string[]
): ProcessorUsagePlan => {
  let displayName: string | null = null;
  try {
    displayName = getDisplayName(usage.ancestors, idx, code, filename);
  } catch {
    displayName = null;
  }

  return {
    declarativeSemantics:
      usage.definedProcessor[2]?.declarativeSemantics ?? null,
    displayName,
    imported: usage.definedProcessor[1].imported,
    kind: usage.kind,
    local: getUsageLocal(usage),
    source: usage.definedProcessor[1].source,
    staticValueNames,
  };
};

const dedupeNeeds = (needs: StaticNeed[]): StaticNeed[] => {
  const seen = new Set<string>();
  const deduped: StaticNeed[] = [];

  needs.forEach((need) => {
    const key = JSON.stringify(need);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    deduped.push(need);
  });

  return deduped;
};

export const buildStaticPlan = ({
  code,
  filename,
  options,
  preparedImports,
  preevalResult,
  processorImports = discoverProcessorImports({ code, filename, options }),
  staticBindings = options?.staticBindings,
}: BuildStaticPlanInput): StaticPlan => {
  const program = parseOxc(code, filename);
  const usages = collectProcessorUsages(
    program,
    createDefinedProcessors(processorImports)
  );
  const targetExpressionSpans = usages.flatMap(collectUsageExpressionSpans);
  const emptyExtraction = {
    code,
    dependencyNames: [],
    expressionValues: [],
    staticValueCandidates: [],
    staticValues: [],
  };
  const extractPlannedSpans = () => {
    try {
      return collectOxcExpressionDependencies(
        code,
        filename,
        true,
        targetExpressionSpans,
        staticBindings
      );
    } catch {
      // The plan is a speculative optimization: expressions it cannot model
      // (e.g. processor call arguments that reference function parameters)
      // must degrade to the eval path, not fail the build. Genuine template
      // diagnostics are still raised by the authoritative transform path.
      return emptyExtraction;
    }
  };
  const extracted =
    targetExpressionSpans.length > 0 ? extractPlannedSpans() : emptyExtraction;
  const env: StaticEnv = {
    dependencies: collectRuntimeDependencies(preparedImports, preevalResult),
    unresolved: new Map(),
    values: new Map(
      extracted.staticValues.map((item) => [
        item.name,
        toProcessorStaticValue(item.value),
      ])
    ),
  };
  const needs: StaticNeed[] = [];

  extracted.staticValueCandidates.forEach((candidate) => {
    if (candidate.imports.length === 0) {
      return;
    }

    if (!env.values.has(candidate.name)) {
      env.unresolved.set(candidate.name, {
        details: {
          imports: candidate.imports.map((item) => ({
            imported: item.imported,
            source: item.source,
          })),
          source: candidate.source,
        },
        kind: 'unresolved',
        reason: 'static-import',
      });
    }

    candidate.imports.forEach((item) => {
      needs.push({
        importer: filename,
        kind: 'export',
        name: item.imported,
        reason: 'processor-static-interpolation',
        source: item.source,
      });
    });
  });

  const staticValueNames = unique(
    extracted.expressionValues.flatMap((value) =>
      value.ex.type === 'Identifier' ? [value.ex.name] : []
    )
  );
  const processorUsages = usages.map((usage, idx) =>
    toProcessorUsagePlan(usage, idx, code, filename, staticValueNames)
  );
  const evalNeeds = resolveUnmetStaticNeeds({
    filename,
    resolvedNames: new Set(preevalResult?.staticValueCache?.keys() ?? []),
    runtimeOnlyNames: new Set(preevalResult?.runtimeOnlyStaticValueNames ?? []),
    unresolvedNames: preevalResult?.dependencyNames ?? [],
  });
  const dedupedNeeds = dedupeNeeds([...needs, ...evalNeeds]);
  const needRequests = planStaticNeedRequests(dedupedNeeds);

  return {
    attribution: {
      needCount: dedupedNeeds.length,
      needRequestCount: needRequests.length,
      runtimeDependencyCount: env.dependencies.size,
      staticValueCount: env.values.size,
      unresolvedCount: env.unresolved.size,
      usageCount: processorUsages.length,
    },
    env,
    evalPayload: null,
    filename,
    needs: dedupedNeeds,
    needRequests,
    processorUsages,
  };
};

export const emitStaticPlanDebug = (
  eventEmitter: EventEmitter,
  plan: StaticPlan
): void => {
  if (!eventEmitter.enabled) {
    return;
  }

  eventEmitter.single({
    filename: plan.filename,
    needCount: plan.attribution.needCount,
    needRequestCount: plan.attribution.needRequestCount,
    runtimeDependencyCount: plan.attribution.runtimeDependencyCount,
    staticValueCount: plan.attribution.staticValueCount,
    type: 'staticPlan',
    unresolvedCount: plan.attribution.unresolvedCount,
    usageCount: plan.attribution.usageCount,
  });
};
