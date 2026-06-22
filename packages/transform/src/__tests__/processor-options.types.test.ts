/* eslint-env jest */
import type { IOptions } from '@wyw-in-js/processor-utils';
import type { StrictOptions } from '@wyw-in-js/shared';
import type {
  PluginOptions,
  WywInJsProcessorOptions as TransformProcessorOptions,
} from '../index';

type SharedProcessorOptions = NonNullable<StrictOptions['processors']>;

declare module '@wyw-in-js/shared' {
  interface WywInJsProcessorOptions {
    typedProcessorOptionsTest?: {
      minifyClassNames?: boolean;
    };
  }
}

describe('typed processor options', () => {
  it('exposes augmented processor options across public option types', () => {
    const sharedOptions: SharedProcessorOptions = {
      typedProcessorOptionsTest: {
        minifyClassNames: true,
      },
    };
    const transformOptions: TransformProcessorOptions = sharedOptions;
    const pluginOptions: Pick<PluginOptions, 'processors'> = {
      processors: transformOptions,
    };
    const strictOptions: Pick<StrictOptions, 'processors'> = pluginOptions;
    const processorOptions: Pick<IOptions, 'processors'> = strictOptions;

    expect(
      processorOptions.processors?.typedProcessorOptionsTest?.minifyClassNames
    ).toBe(true);
  });
});
