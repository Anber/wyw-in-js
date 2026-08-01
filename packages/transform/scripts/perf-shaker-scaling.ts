/* eslint-disable no-console, no-continue, no-restricted-syntax */
import { createHash } from 'crypto';

import { shakeOxcToESM } from '../src/utils/oxcShaker';

type CliOptions = {
  iterations: number;
  json: boolean;
  warmup: number;
};

type BenchmarkScenario =
  | 'alias-chain'
  | 'alias-cycle'
  | 'cohort-chain'
  | 'direct-grid'
  | 'local-result-dormant'
  | 'local-result-invoke-all'
  | 'nested-rest-all-mutations'
  | 'nested-rest-chain';

type BenchmarkCase = {
  dimensions: Record<string, number>;
  id: string;
  label: string;
  onlyExports: string[];
  scenario: BenchmarkScenario;
  source: string;
};

type OutputSignature = {
  codeBytes: number;
  codeSha256: string;
  imports: Array<[string, string[]]>;
  importsSha256: string;
  sourceBytes: number;
  sourceSha256: string;
};

type GoldenSignature = string;

type ScalingResult = {
  dimensions: Record<string, number>;
  id: string;
  label: string;
  medianMs: number;
  relativeToScenarioBaseline: number;
  samplesMs: number[];
  scenario: BenchmarkScenario;
  signature: OutputSignature;
  trimCount: number;
  trimmedMeanMs: number;
};

const DIRECT_IMPORT_COUNTS = [16, 32, 64] as const;
const DIRECT_CALL_RESULT_COUNTS = [4, 16, 64] as const;
const COHORT_RESULT_COUNTS = [16, 32, 64, 128] as const;
const ALIAS_COUNTS = [64, 128, 256, 512] as const;
const LOCAL_RESULT_COUNTS = [64, 128, 256, 512] as const;
const NESTED_REST_COUNTS = [16, 32, 64, 128, 256] as const;
const COHORT_ROOT_IMPORTS = 16;
const TRIM_FRACTION = 0.1;

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const range = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index);

const buildDirectSource = (imports: number, callResults: number): string => {
  const names = range(imports).map((index) => `imp${index}`);
  const results = range(callResults).map(
    (index) =>
      `const result${index} = imp${index % imports}(` +
      `imp${(index + 1) % imports});`
  );

  return [
    `import { ${names.join(', ')} } from './dependency.js';`,
    ...results,
    `export const keep = result${callResults - 1};`,
  ].join('\n');
};

const buildCohortChainSource = (resultCount: number): string => {
  const imports = range(COHORT_ROOT_IMPORTS).map((index) => `imp${index}`);
  const results = range(resultCount).map((index) =>
    index === 0
      ? 'const result0 = imp0();'
      : `const result${index} = imp${index % COHORT_ROOT_IMPORTS}(` +
        `result${index - 1});`
  );
  const invocations = range(resultCount).map((index) => `result${index}();`);

  return [
    `import { anchor, ${imports.join(', ')} } from './dependency.js';`,
    ...results,
    ...invocations,
    'export { anchor };',
  ].join('\n');
};

const buildAliasChainSource = (aliasCount: number): string => {
  const aliases = range(aliasCount).map(
    (index) =>
      `let alias${index} = ${index === 0 ? 'imported' : `alias${index - 1}`};`
  );
  const invocations = range(aliasCount).map((index) => `alias${index}();`);

  return [
    `import { anchor, imported } from './dependency.js';`,
    ...aliases,
    ...invocations,
    'export { anchor };',
  ].join('\n');
};

const buildAliasCycleSource = (aliasCount: number): string => {
  const aliases = range(aliasCount).map(
    (index) =>
      `let cycle${index} = ${index === 0 ? 'imported' : `cycle${index - 1}`};`
  );
  const invocations = range(aliasCount).map((index) => `cycle${index}();`);

  return [
    `import { anchor, imported } from './dependency.js';`,
    ...aliases,
    `cycle0 = cycle${aliasCount - 1};`,
    ...invocations,
    'export { anchor };',
  ].join('\n');
};

const buildLocalResultChainSource = (
  resultCount: number,
  invokeAll: boolean
): string => {
  const sources = range(resultCount).map(
    (index) => `const source${index} = {};`
  );
  const results = range(resultCount).map((index) =>
    index === 0
      ? 'const result0 = make(source0);'
      : `const result${index} = make(result${index - 1}, source${index});`
  );
  const invocations = invokeAll
    ? range(resultCount).map((index) => `result${index}();`)
    : [];

  return [
    ...sources,
    'function make(previous, local) {',
    '  return () => [previous, local];',
    '}',
    ...results,
    ...invocations,
    'export { source0 };',
  ].join('\n');
};

const buildNestedRestChainSource = (restCount: number): string => {
  const rests = range(restCount).map(
    (index) =>
      `const { ...rest${index} } = ` +
      `${index === 0 ? 'source' : `rest${index - 1}`};`
  );

  return [
    'const source = { nested: { width: 304 } };',
    ...rests,
    `rest${restCount - 1}.nested.width = 400;`,
    'export { source };',
  ].join('\n');
};

const buildNestedRestAllMutationsSource = (restCount: number): string => {
  const rests = range(restCount).map(
    (index) =>
      `const { ...rest${index} } = ${
        index === 0 ? 'source' : `rest${index - 1}`
      };`
  );
  const mutations = range(restCount).map(
    (index) => `rest${index}.nested.width = ${index + 1};`
  );

  return [
    'const source = { nested: { width: 304 } };',
    ...rests,
    ...mutations,
    'export { source };',
  ].join('\n');
};

const directCases: BenchmarkCase[] = DIRECT_IMPORT_COUNTS.flatMap((imports) =>
  DIRECT_CALL_RESULT_COUNTS.map((callResults) => ({
    dimensions: { callResults, imports },
    id: `direct-${imports}x${callResults}`,
    label: `${imports} imports x ${callResults} results`,
    onlyExports: ['keep'],
    scenario: 'direct-grid' as const,
    source: buildDirectSource(imports, callResults),
  }))
);

const cohortCases: BenchmarkCase[] = COHORT_RESULT_COUNTS.map(
  (resultCount) => ({
    dimensions: {
      results: resultCount,
      rootImports: COHORT_ROOT_IMPORTS,
    },
    id: `cohort-chain-${resultCount}`,
    label: `${resultCount} results`,
    onlyExports: ['anchor'],
    scenario: 'cohort-chain',
    source: buildCohortChainSource(resultCount),
  })
);

const aliasChainCases: BenchmarkCase[] = ALIAS_COUNTS.map((aliasCount) => ({
  dimensions: { aliases: aliasCount },
  id: `alias-chain-${aliasCount}`,
  label: `${aliasCount} aliases`,
  onlyExports: ['anchor'],
  scenario: 'alias-chain',
  source: buildAliasChainSource(aliasCount),
}));

const aliasCycleCases: BenchmarkCase[] = ALIAS_COUNTS.map((aliasCount) => ({
  dimensions: { aliases: aliasCount },
  id: `alias-cycle-${aliasCount}`,
  label: `${aliasCount} aliases`,
  onlyExports: ['anchor'],
  scenario: 'alias-cycle',
  source: buildAliasCycleSource(aliasCount),
}));

const createLocalResultCases = (
  scenario: 'local-result-dormant' | 'local-result-invoke-all',
  invokeAll: boolean
): BenchmarkCase[] =>
  LOCAL_RESULT_COUNTS.map((resultCount) => ({
    dimensions: { results: resultCount },
    id: `${scenario}-${resultCount}`,
    label: `${resultCount} results`,
    onlyExports: ['source0'],
    scenario,
    source: buildLocalResultChainSource(resultCount, invokeAll),
  }));

const localResultDormantCases = createLocalResultCases(
  'local-result-dormant',
  false
);
const localResultInvokeAllCases = createLocalResultCases(
  'local-result-invoke-all',
  true
);

const nestedRestCases: BenchmarkCase[] = NESTED_REST_COUNTS.map(
  (restCount) => ({
    dimensions: { rests: restCount },
    id: `nested-rest-chain-${restCount}`,
    label: `${restCount} rests`,
    onlyExports: ['source'],
    scenario: 'nested-rest-chain',
    source: buildNestedRestChainSource(restCount),
  })
);

const nestedRestAllMutationsCases: BenchmarkCase[] = NESTED_REST_COUNTS.map(
  (restCount) => ({
    dimensions: { rests: restCount },
    id: `nested-rest-all-mutations-${restCount}`,
    label: `${restCount} rests`,
    onlyExports: ['source'],
    scenario: 'nested-rest-all-mutations',
    source: buildNestedRestAllMutationsSource(restCount),
  })
);

const BENCHMARK_CASES: BenchmarkCase[] = [
  ...directCases,
  ...cohortCases,
  ...aliasChainCases,
  ...aliasCycleCases,
  ...localResultDormantCases,
  ...localResultInvokeAllCases,
  ...nestedRestCases,
  ...nestedRestAllMutationsCases,
];

// Bind both the generated fixtures and the shaker result. Timing is
// observational, but any source, emitted-code, or retained-import drift fails.
// Format: codeBytes:codeSha256:importsSha256:sourceBytes:sourceSha256.
const GOLDEN_SIGNATURES: Record<string, GoldenSignature> = {
  'direct-16x4':
    '204:b7e28f3a27c350d0542b0045df5e815c3317bde7ff549b4f59543da96eb0f1db:dce99c2e45342a65445449bfa0d15ba2d9ad222114fab73ed32b191827841694:276:19f84bd4c2e64067067da665b44eef60c98c280641da4c86e246e7389bbad2c5',
  'direct-16x16':
    '631:fb2a49fcb0085209559d7b2522e45c7a0e4bb205b80d6292944ce36fe9b5b13d:c71962f4013a8422e8d2eca099239b656302266f11056f95aff235235c303027:631:fb2a49fcb0085209559d7b2522e45c7a0e4bb205b80d6292944ce36fe9b5b13d',
  'direct-16x64':
    '2059:1e5ec71dce56d1f704d985b8a32656a914a1cda7d18d29c0516028d9da5868a1:c71962f4013a8422e8d2eca099239b656302266f11056f95aff235235c303027:2059:1e5ec71dce56d1f704d985b8a32656a914a1cda7d18d29c0516028d9da5868a1',
  'direct-32x4':
    '204:b7e28f3a27c350d0542b0045df5e815c3317bde7ff549b4f59543da96eb0f1db:dce99c2e45342a65445449bfa0d15ba2d9ad222114fab73ed32b191827841694:388:73ab3e7728535b26c306ae5e9cbc995645ddffa838a8c6a9955c1dac98a06d8f',
  'direct-32x16':
    '639:3c94818a99a56bfa9a148297bd179883c98328cb3a0ba7b5a41a1f80871acd8e:e77569cc29e00a086c41f4bc394dfb431a58bba6ba0b8e78ad07a0e89074cdb9:744:b284c98aa0804143116edf17d45e6ad59f2000a6625edc64cd2a4e568af49dd8',
  'direct-32x64':
    '2211:368b1618baa10c7cd4b8c136601cd8d8504e0755ccea49ebac319fe38b8a7424:b2f1ac8d5357d09ff0842d0e293e8bb7832c33d122170e306a84f78ab6a54c82:2211:368b1618baa10c7cd4b8c136601cd8d8504e0755ccea49ebac319fe38b8a7424',
  'direct-64x4':
    '204:b7e28f3a27c350d0542b0045df5e815c3317bde7ff549b4f59543da96eb0f1db:dce99c2e45342a65445449bfa0d15ba2d9ad222114fab73ed32b191827841694:612:0f486b358f87fb2219e895abd4d7c1e66cdbccc3ebc9279e92efe7b1e194ee7d',
  'direct-64x16':
    '639:3c94818a99a56bfa9a148297bd179883c98328cb3a0ba7b5a41a1f80871acd8e:e77569cc29e00a086c41f4bc394dfb431a58bba6ba0b8e78ad07a0e89074cdb9:968:05163053858a5d57cbb0b6f5d2812142c5fa99802fe43d1c7c2266efb8cbedf5',
  'direct-64x64':
    '2455:c6097baf2876da6faa781086ab4ac0e3ec497775e89eb684e1aaa8ce367cbae0:559bab5d505427870e1f604d22291bb255696eaad9a5d080ee00adf63c2fef58:2455:c6097baf2876da6faa781086ab4ac0e3ec497775e89eb684e1aaa8ce367cbae0',
  'cohort-chain-16':
    '850:bcb518c5a6da3322838a71b7da085fa797ee2d0463cddf3cd9c49d96db282a06:32eabc982918ac41abc29ed4cb64396633a046ec6f55d7c0289364cdc4ae5b4f:850:bcb518c5a6da3322838a71b7da085fa797ee2d0463cddf3cd9c49d96db282a06',
  'cohort-chain-32':
    '1576:1660a134b1850ed9260bbc49802d701453d1478cf95ca6862651d5a8a9a37771:32eabc982918ac41abc29ed4cb64396633a046ec6f55d7c0289364cdc4ae5b4f:1576:1660a134b1850ed9260bbc49802d701453d1478cf95ca6862651d5a8a9a37771',
  'cohort-chain-64':
    '3028:e7655ff79ef1f155e35609b0348fa9b8211d2563b4cb8c7084be7374ef27c42b:32eabc982918ac41abc29ed4cb64396633a046ec6f55d7c0289364cdc4ae5b4f:3028:e7655ff79ef1f155e35609b0348fa9b8211d2563b4cb8c7084be7374ef27c42b',
  'cohort-chain-128':
    '6015:e3d3126255955a01c0a9e7f9672cab06b9e5b04ce84d2eec394ff116682d923a:32eabc982918ac41abc29ed4cb64396633a046ec6f55d7c0289364cdc4ae5b4f:6015:e3d3126255955a01c0a9e7f9672cab06b9e5b04ce84d2eec394ff116682d923a',
  'alias-chain-64':
    '2217:4daafd2ecc04f649ea3e3cadf8444ba299bfd2af4c36de85f6f8fc4244ff4071:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:2217:4daafd2ecc04f649ea3e3cadf8444ba299bfd2af4c36de85f6f8fc4244ff4071',
  'alias-chain-128':
    '4476:d9d2ae7c32993aaa39dee744f50267bb233f82d6d0d5984b531c068daed1fea1:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:4476:d9d2ae7c32993aaa39dee744f50267bb233f82d6d0d5984b531c068daed1fea1',
  'alias-chain-256':
    '9212:848d4178d3cafafbeac59be8d5c62dbb25634be58c90483ad29bb91dfc35d7fb:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:9212:848d4178d3cafafbeac59be8d5c62dbb25634be58c90483ad29bb91dfc35d7fb',
  'alias-chain-512':
    '18684:2e3a0aeb4e4582b3ec60f9b0ddc041904bb6a31fab4d5eababdba033d037e397:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:18684:2e3a0aeb4e4582b3ec60f9b0ddc041904bb6a31fab4d5eababdba033d037e397',
  'alias-cycle-64':
    '2235:6880efb9097c7dcda195420a9e19cb5fab2ce48987f0af81f79aea935947fc27:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:2235:6880efb9097c7dcda195420a9e19cb5fab2ce48987f0af81f79aea935947fc27',
  'alias-cycle-128':
    '4495:5e078ff589096accb4b8167978d4ccf174bf6064d9f652c7d3c41b9ff138be28:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:4495:5e078ff589096accb4b8167978d4ccf174bf6064d9f652c7d3c41b9ff138be28',
  'alias-cycle-256':
    '9231:f27e71fc43e1b2f6de92d0fd1d84b44d107cd19dcc7fa89d8aade8d5d46c82a2:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:9231:f27e71fc43e1b2f6de92d0fd1d84b44d107cd19dcc7fa89d8aade8d5d46c82a2',
  'alias-cycle-512':
    '18703:97e665fd2b63ef165e5170bd6a66a2566fa5efd94c4c54c25d284b3358a0e8fd:6657d4c33babfcceb43a2a860b170cad87e104b0fb16c5fb271badb9720a5d7e:18703:97e665fd2b63ef165e5170bd6a66a2566fa5efd94c4c54c25d284b3358a0e8fd',
  'local-result-dormant-64':
    '4134:341dbd95e843ed2f7ab8db470ba22a86790e056b9f7b660ffe93beb27d640810:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:4134:341dbd95e843ed2f7ab8db470ba22a86790e056b9f7b660ffe93beb27d640810',
  'local-result-dormant-128':
    '8341:ebe79776d47921e5c99e99e8eec9d3c757cf61454787a05cfea0e00257102c5a:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:8341:ebe79776d47921e5c99e99e8eec9d3c757cf61454787a05cfea0e00257102c5a',
  'local-result-dormant-256':
    '17045:fff60c559bc1e8f9377b5f4a18668f0b32f6650740d7a46040041c7f7c193271:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:17045:fff60c559bc1e8f9377b5f4a18668f0b32f6650740d7a46040041c7f7c193271',
  'local-result-dormant-512':
    '34453:f1d029e385a7d7dc617c84e54bb78b4210a2322b22c0b772cbebd833a779e6e7:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:34453:f1d029e385a7d7dc617c84e54bb78b4210a2322b22c0b772cbebd833a779e6e7',
  'local-result-invoke-all-64':
    '4892:00534be4a52bba701f4dfcd739daed3388ceb8d3916f367de821e7d2f98be241:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:4892:00534be4a52bba701f4dfcd739daed3388ceb8d3916f367de821e7d2f98be241',
  'local-result-invoke-all-128':
    '9895:4974cd01f064a0930d864e00dcd9bc28bff7475bb9e6fb6ee3a4b0f6c5c6d489:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:9895:4974cd01f064a0930d864e00dcd9bc28bff7475bb9e6fb6ee3a4b0f6c5c6d489',
  'local-result-invoke-all-256':
    '20263:403b099bfc30a235e177e399ab7e34657f6d0575f10e96ef9ecf4903184f6a9b:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:20263:403b099bfc30a235e177e399ab7e34657f6d0575f10e96ef9ecf4903184f6a9b',
  'local-result-invoke-all-512':
    '40999:bbb7fe68d5624833bda514322151144f0730109a943ffc32d7b5157c19a435e4:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:40999:bbb7fe68d5624833bda514322151144f0730109a943ffc32d7b5157c19a435e4',
  'nested-rest-chain-16':
    '548:8ac690ef5182d82b20f9c4101d0b9234f7e8ab6d6711da5fb28589a16042bb08:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:548:8ac690ef5182d82b20f9c4101d0b9234f7e8ab6d6711da5fb28589a16042bb08',
  'nested-rest-chain-32':
    '1028:962606bfbc7118c45de1672cc837393e0d8f0c7925c95bd12eb4018b53d19518:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:1028:962606bfbc7118c45de1672cc837393e0d8f0c7925c95bd12eb4018b53d19518',
  'nested-rest-chain-64':
    '1988:43da470ab32fb898c7098647f5f60ce032796c5d29a81848bb7c34fb4103a6ee:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:1988:43da470ab32fb898c7098647f5f60ce032796c5d29a81848bb7c34fb4103a6ee',
  'nested-rest-chain-128':
    '3964:5a549a0edb2e53045015c24ab16e04f1ace2c571d1a64fe73d19f685ae174ea6:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:3964:5a549a0edb2e53045015c24ab16e04f1ace2c571d1a64fe73d19f685ae174ea6',
  'nested-rest-chain-256':
    '8060:4294f5dc732b910960372d3d3035e35c351ab2bdbacaa3a3d763581d774058f2:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:8060:4294f5dc732b910960372d3d3035e35c351ab2bdbacaa3a3d763581d774058f2',
  'nested-rest-all-mutations-16':
    '918:7fb73f3522e67ddb1617a062012c05e08062e1ebc0f8634032e7fbb8858aaf3f:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:918:7fb73f3522e67ddb1617a062012c05e08062e1ebc0f8634032e7fbb8858aaf3f',
  'nested-rest-all-mutations-32':
    '1814:5425037af68c5ef2b69e5ac64a6ceabd4dc15d49fbc93b461147d83c38b97efb:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:1814:5425037af68c5ef2b69e5ac64a6ceabd4dc15d49fbc93b461147d83c38b97efb',
  'nested-rest-all-mutations-64':
    '3606:3b1010f09c274121438838cfd3e51bc1e647d1fb0f4f754328ee344aae71f802:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:3606:3b1010f09c274121438838cfd3e51bc1e647d1fb0f4f754328ee344aae71f802',
  'nested-rest-all-mutations-128':
    '7302:5140a5d5c20e7eb6331d14958b9d193fcc0fedbbc8f47d821eff7e0bdb36c883:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:7302:5140a5d5c20e7eb6331d14958b9d193fcc0fedbbc8f47d821eff7e0bdb36c883',
  'nested-rest-all-mutations-256':
    '14982:42214b04277fdf39002d2b942cc16c2868a431bff24552da40a1e68a68596185:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945:14982:42214b04277fdf39002d2b942cc16c2868a431bff24552da40a1e68a68596185',
};

const assertGoldenCoverage = (): void => {
  const caseIds = new Set(BENCHMARK_CASES.map(({ id }) => id));
  if (caseIds.size !== BENCHMARK_CASES.length) {
    throw new Error('Benchmark case ids must be unique');
  }
  const goldenIds = Object.keys(GOLDEN_SIGNATURES);
  const missing = [...caseIds].filter(
    (id) => !Object.prototype.hasOwnProperty.call(GOLDEN_SIGNATURES, id)
  );
  const unexpected = goldenIds.filter((id) => !caseIds.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Golden signature coverage mismatch\n` +
        `Missing: ${JSON.stringify(missing)}\n` +
        `Unexpected: ${JSON.stringify(unexpected)}`
    );
  }
};

const canonicalImports = (
  imports: ReadonlyMap<string, readonly string[]>
): Array<[string, string[]]> =>
  [...imports]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, imported]) => [source, [...imported].sort()]);

const createSignature = (
  source: string,
  result: ReturnType<typeof shakeOxcToESM>
): OutputSignature => {
  const imports = canonicalImports(result.imports);
  return {
    codeBytes: Buffer.byteLength(result.code),
    codeSha256: hash(result.code),
    imports,
    importsSha256: hash(JSON.stringify(imports)),
    sourceBytes: Buffer.byteLength(source),
    sourceSha256: hash(source),
  };
};

const createGoldenSignature = (signature: OutputSignature): GoldenSignature =>
  [
    signature.codeBytes,
    signature.codeSha256,
    signature.importsSha256,
    signature.sourceBytes,
    signature.sourceSha256,
  ].join(':');

const assertGoldenSignature = (
  benchmarkCase: BenchmarkCase,
  signature: OutputSignature
): void => {
  const expected = GOLDEN_SIGNATURES[benchmarkCase.id];
  if (!expected) {
    throw new Error(`Missing golden signature for ${benchmarkCase.id}`);
  }

  const actual = createGoldenSignature(signature);
  if (actual !== expected) {
    throw new Error(
      `Golden signature mismatch for ${benchmarkCase.id}\n` +
        `Expected: ${expected}\n` +
        `Actual: ${JSON.stringify(signature)}`
    );
  }
};

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const round = (value: number): number => Math.round(value * 1000) / 1000;

const parseArgs = (): CliOptions => {
  const options: CliOptions = {
    iterations: 10,
    json: false,
    warmup: 1,
  };
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--iterations') {
      options.iterations = Number(args[(index += 1)]);
      continue;
    }
    if (arg === '--warmup') {
      options.warmup = Number(args[(index += 1)]);
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run ./scripts/perf-shaker-scaling.ts [options]

Options:
  --iterations <n>  measured runs per benchmark cell (default: 10; minimum: 10)
  --warmup <n>      warmup runs per benchmark cell (default: 1)
  --json            print the complete samples and signatures as JSON
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.iterations) || options.iterations < 10) {
    throw new Error('--iterations must be an integer of at least 10');
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error('--warmup must be a non-negative integer');
  }

  return options;
};

const runCell = (
  benchmarkCase: BenchmarkCase,
  options: CliOptions
): Omit<ScalingResult, 'relativeToScenarioBaseline'> => {
  const run = () =>
    shakeOxcToESM(
      benchmarkCase.source,
      `/perf/shaker-scaling-${benchmarkCase.id}.js`,
      {
        keepSideEffects: true,
        onlyExports: benchmarkCase.onlyExports,
      }
    );
  let expectedSignature: OutputSignature | undefined;
  let serializedSignature: string | undefined;

  const runVerified = (): number => {
    const startedAt = performance.now();
    const result = run();
    const elapsedMs = performance.now() - startedAt;
    const signature = createSignature(benchmarkCase.source, result);
    assertGoldenSignature(benchmarkCase, signature);
    const serialized = JSON.stringify(signature);

    if (serializedSignature === undefined) {
      expectedSignature = signature;
      serializedSignature = serialized;
    } else if (serialized !== serializedSignature) {
      throw new Error(`Unstable output signature for ${benchmarkCase.id}`);
    }

    return elapsedMs;
  };

  for (let index = 0; index < options.warmup; index += 1) {
    runVerified();
  }

  const samplesMs = range(options.iterations).map(() => runVerified());
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const trimCount = Math.floor(sorted.length * TRIM_FRACTION);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);

  return {
    dimensions: benchmarkCase.dimensions,
    id: benchmarkCase.id,
    label: benchmarkCase.label,
    medianMs: round(median(sorted)),
    samplesMs: samplesMs.map(round),
    scenario: benchmarkCase.scenario,
    signature: expectedSignature!,
    trimCount,
    trimmedMeanMs: round(mean(trimmed)),
  };
};

const printTable = (results: ScalingResult[], options: CliOptions): void => {
  console.log(
    `Shaker scaling (${options.warmup} warmup, ` +
      `${options.iterations} measured, ${TRIM_FRACTION * 100}% trim)`
  );
  const scenarioWidth = Math.max(
    'Scenario'.length,
    ...results.map(({ scenario }) => scenario.length)
  );
  const cellWidth = Math.max(
    'Cell'.length,
    ...results.map(({ label }) => label.length)
  );
  const header = [
    'Scenario'.padEnd(scenarioWidth),
    'Cell'.padEnd(cellWidth),
    'Median ms'.padStart(11),
    'Trimmed ms'.padStart(12),
    'vs first'.padStart(9),
    'Code bytes'.padStart(11),
    'Signature'.padStart(14),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  results.forEach((result) => {
    console.log(
      [
        result.scenario.padEnd(scenarioWidth),
        result.label.padEnd(cellWidth),
        result.medianMs.toFixed(3).padStart(11),
        result.trimmedMeanMs.toFixed(3).padStart(12),
        `${result.relativeToScenarioBaseline.toFixed(2)}x`.padStart(9),
        String(result.signature.codeBytes).padStart(11),
        result.signature.codeSha256.slice(0, 12).padStart(14),
      ].join(' ')
    );
  });
};

const main = (): void => {
  const options = parseArgs();
  assertGoldenCoverage();
  const partialResults = BENCHMARK_CASES.map((benchmarkCase) =>
    runCell(benchmarkCase, options)
  );
  const scenarioBaselines = new Map<BenchmarkScenario, number>();
  const results: ScalingResult[] = partialResults.map((result) => {
    const baseline =
      scenarioBaselines.get(result.scenario) ?? result.trimmedMeanMs;
    scenarioBaselines.set(result.scenario, baseline);
    return {
      ...result,
      relativeToScenarioBaseline: round(result.trimmedMeanMs / baseline),
    };
  });

  printTable(results, options);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          matrix: {
            aliasCounts: ALIAS_COUNTS,
            cohortResultCounts: COHORT_RESULT_COUNTS,
            cohortRootImports: COHORT_ROOT_IMPORTS,
            directCallResults: DIRECT_CALL_RESULT_COUNTS,
            directImports: DIRECT_IMPORT_COUNTS,
            localResultCounts: LOCAL_RESULT_COUNTS,
            nestedRestAllMutationCounts: NESTED_REST_COUNTS,
            nestedRestCounts: NESTED_REST_COUNTS,
          },
          options: {
            iterations: options.iterations,
            trimFraction: TRIM_FRACTION,
            warmup: options.warmup,
          },
          results,
        },
        null,
        2
      )
    );
  }
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
