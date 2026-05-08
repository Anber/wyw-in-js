import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const resolverFacade = join(
  __dirname,
  '..',
  'transform',
  'generators',
  'resolveStaticOxcValues.ts'
);
const resolverModulesDir = join(
  __dirname,
  '..',
  'transform',
  'generators',
  'resolveStaticOxcValues'
);
const processorAdapterFile = join(
  resolverModulesDir,
  'processorStaticModel.ts'
);

describe('resolveStaticOxcValues module boundary', () => {
  it('keeps WyW metadata shape interpretation in the processor adapter', () => {
    const coreFiles = [
      resolverFacade,
      ...readdirSync(resolverModulesDir)
        .filter(
          (file) => file.endsWith('.ts') && file !== 'processorStaticModel.ts'
        )
        .map((file) => join(resolverModulesDir, file)),
    ];

    const offenders = coreFiles.filter((file) =>
      readFileSync(file, 'utf8').includes('__wyw_meta')
    );

    expect(offenders).toEqual([]);
    expect(readFileSync(processorAdapterFile, 'utf8')).toContain('__wyw_meta');
  });
});
