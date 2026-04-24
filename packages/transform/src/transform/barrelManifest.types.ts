export type BarrelSkipReason =
  | 'custom-evaluator'
  | 'empty'
  | 'ignored'
  | 'impure'
  | 'namespace-barrel'
  | 'unknown-star';

export type BarrelBlockedReason =
  | 'ambiguous'
  | 'cycle'
  | 'namespace-barrel'
  | 'unknown-star'
  | 'unresolved';

export type BarrelResolvedBinding =
  | {
      imported: string;
      kind: 'named';
      source: string;
    }
  | {
      kind: 'namespace';
      source: string;
    };

export type BarrelManifestExport =
  | BarrelResolvedBinding
  | {
      kind: 'blocked';
      reason: BarrelBlockedReason;
    };

export type BarrelManifest = {
  complete: boolean;
  exports: Record<string, BarrelManifestExport>;
  kind: 'barrel';
};

export type BarrelManifestCacheEntry =
  | BarrelManifest
  | {
      kind: 'ineligible';
      reason: BarrelSkipReason;
    };

export type RawBarrelReexport =
  | {
      exported: string;
      imported: string;
      kind: 'named';
      source: string;
    }
  | {
      exported: string;
      kind: 'namespace';
      source: string;
    };

export type RawBarrelManifest = {
  complete: boolean;
  explicitExports: string[];
  exportAll: string[];
  kind: 'barrel';
  reexports: RawBarrelReexport[];
};
