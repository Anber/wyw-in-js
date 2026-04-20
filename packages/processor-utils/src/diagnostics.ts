import type { Artifact } from '@wyw-in-js/shared';

import type { ProcessorDiagnostic } from './types';

export const PROCESSOR_DIAGNOSTIC_ARTIFACT = 'wyw-in-js:diagnostic' as const;

export type ProcessorDiagnosticArtifact = [
  name: typeof PROCESSOR_DIAGNOSTIC_ARTIFACT,
  data: ProcessorDiagnostic,
];

export const createProcessorDiagnosticArtifact = (
  diagnostic: ProcessorDiagnostic
): ProcessorDiagnosticArtifact => [PROCESSOR_DIAGNOSTIC_ARTIFACT, diagnostic];

export const isProcessorDiagnosticArtifact = (
  artifact: Artifact
): artifact is ProcessorDiagnosticArtifact =>
  artifact[0] === PROCESSOR_DIAGNOSTIC_ARTIFACT;
