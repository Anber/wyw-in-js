import type { Program } from 'oxc-parser';

type BuildProgramFacts<Facts> = (
  program: Program,
  code: string,
  isEsModule: boolean
) => Facts;

/**
 * Parsed Programs are immutable and reused by the Oxc parse cache. Keep the
 * option-invariant shaker analysis attached to that identity while allowing
 * the parse cache to evict Programs normally.
 */
export const createShakerProgramFactsCache = <Facts>(
  build: BuildProgramFacts<Facts>
): BuildProgramFacts<Facts> => {
  const factsByProgram = new WeakMap<
    Program,
    { code: string; facts: Facts; isEsModule: boolean }
  >();

  return (program, code, isEsModule) => {
    const cached = factsByProgram.get(program);
    if (cached?.code === code && cached.isEsModule === isEsModule) {
      return cached.facts;
    }

    const facts = build(program, code, isEsModule);
    factsByProgram.set(program, { code, facts, isEsModule });
    return facts;
  };
};
