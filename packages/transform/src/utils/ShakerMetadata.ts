export interface IShakerMetadata {
  imports: Map<string, string[]>;
}

export interface IMetadata {
  linariaEvaluator: IShakerMetadata;
}

export const hasShakerMetadata = (
  metadata: object | undefined
): metadata is IMetadata =>
  metadata !== undefined && 'linariaEvaluator' in metadata;
