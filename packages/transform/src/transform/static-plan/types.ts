import type {
  ProcessorStaticUnresolvedValue,
  ProcessorStaticValue,
} from '@wyw-in-js/processor-utils';

export type PrevalPayloadSource = 'eval' | 'static';

export type PrevalPayload = {
  dependencies: string[];
  sources: Map<string, PrevalPayloadSource>;
  values: Map<string, unknown>;
};

export type StaticEnv = {
  dependencies: Set<string>;
  unresolved: Map<string, ProcessorStaticUnresolvedValue>;
  values: Map<string, ProcessorStaticValue>;
};

export type StaticNeed =
  | {
      importer: string;
      kind: 'export';
      name: string;
      reason: string;
      source: string;
    }
  | {
      importer: string;
      kind: 'eval';
      only: string[];
      reason: string;
      source: string;
    }
  | {
      exportName: string;
      importer: string;
      kind: 'processor-metadata';
      reason: string;
      source: string;
    };

export type ProcessorUsagePlan = {
  displayName: string | null;
  imported: string;
  kind: 'call' | 'template';
  local: string;
  source: string;
  staticValueNames: string[];
};

export type StaticPlanAttribution = {
  needCount: number;
  runtimeDependencyCount: number;
  staticValueCount: number;
  unresolvedCount: number;
  usageCount: number;
};

export type StaticPlan = {
  attribution: StaticPlanAttribution;
  env: StaticEnv;
  evalPayload: PrevalPayload | null;
  filename: string;
  needs: StaticNeed[];
  processorUsages: ProcessorUsagePlan[];
};
