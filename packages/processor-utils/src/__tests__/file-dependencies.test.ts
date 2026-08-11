import { resolve } from 'node:path';

import { BaseProcessor } from '../BaseProcessor';

type TestableProcessor = {
  fileDependencies: string[];
  registerFileDependency(filename: string): void;
};

const createProcessor = (): TestableProcessor => {
  const processor = Object.create(BaseProcessor.prototype) as TestableProcessor;
  processor.fileDependencies = [];
  return processor;
};

describe('processor file dependencies', () => {
  it('records absolute identities once in registration order', () => {
    const processor = createProcessor();
    const first = resolve('tokens.json');
    const second = resolve('dx-styles.dtcg.json');

    processor.registerFileDependency(first);
    processor.registerFileDependency(first);
    processor.registerFileDependency(second);

    expect(processor.fileDependencies).toEqual([first, second]);
  });

  it.each(['', 'tokens.json', 'tokens\0.json'])(
    'rejects malformed identity %j without resolving it against cwd',
    (filename) => {
      const processor = createProcessor();

      expect(() => processor.registerFileDependency(filename)).toThrow(
        '[wyw-in-js] Processor file dependencies must be absolute paths without NUL bytes.'
      );
      expect(processor.fileDependencies).toEqual([]);
    }
  );
});
