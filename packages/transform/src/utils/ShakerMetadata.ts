export interface IShakerMetadata {
  imports: Map<string, string[]>;
}

export interface IMetadata {
  wywEvaluator: IShakerMetadata;
}

export const hasShakerMetadata = (
  metadata: object | undefined
): metadata is IMetadata =>
  metadata !== undefined && 'wywEvaluator' in metadata;
