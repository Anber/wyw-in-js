import type {
  BaseProcessor,
  ProcessorDiagnostic,
} from '@wyw-in-js/processor-utils';
import { isProcessorDiagnosticArtifact } from '@wyw-in-js/processor-utils';

type DiagnosticProcessor = Pick<
  BaseProcessor,
  'artifacts' | 'className' | 'displayName'
>;

export type WYWTransformDiagnostic = ProcessorDiagnostic & {
  className: string;
  displayName: string;
  filename: string;
};

export const collectTransformDiagnostics = (
  filename: string,
  processors: DiagnosticProcessor[]
): WYWTransformDiagnostic[] =>
  processors.flatMap((processor) =>
    processor.artifacts
      .filter(isProcessorDiagnosticArtifact)
      .map(([, diagnostic]) => ({
        ...diagnostic,
        className: processor.className,
        displayName: processor.displayName,
        end: diagnostic.end ?? null,
        filename,
        start: diagnostic.start ?? null,
      }))
  );
