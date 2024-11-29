import {
  type TransformOptions,
  TransformTargetProcessors,
  transform,
} from '../index';

describe('sample-tag-processor', () => {
  it('should transform', () => {
    const code = `
    import { sampleTag } from 'sample-tag';
    
    export const styles = sampleTag\`Hello, world!\`;
  `;
    const options: TransformOptions = {
      targets: [
        {
          specifier: 'sample-tag',
          source: 'sampleTag',
          processor: TransformTargetProcessors.SampleTag,
        },
      ],
    };

    const result = transform('index.ts', code, options);

    expect(result).toBe('Hello, World!');
  });
});
