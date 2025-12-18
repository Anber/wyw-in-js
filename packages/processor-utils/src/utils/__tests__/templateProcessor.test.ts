import type { TemplateElement } from '@babel/types';

import { ValueType } from '@wyw-in-js/shared';

import type { TaggedTemplateProcessor } from '../../TaggedTemplateProcessor';
import type { Value, ValueCache } from '../../types';
import templateProcessor from '../templateProcessor';

const buildTemplateElement = (text: string): TemplateElement => ({
  type: 'TemplateElement',
  value: { cooked: text, raw: text },
  tail: false,
  loc: {
    start: { line: 1, column: 0 },
    end: { line: 1, column: text.length },
  },
});

const buildFunctionExpressionValue = () => ({
  buildCodeFrameError: (msg: string) => new Error(msg),
  ex: {
    type: 'Identifier' as const,
    name: 'value',
    loc: {
      start: { line: 1, column: 0 },
      end: { line: 1, column: 1 },
    },
  },
  kind: ValueType.FUNCTION,
  source: 'value',
});

type TemplateProcessorMock = Pick<
  TaggedTemplateProcessor,
  | 'addInterpolation'
  | 'extractRules'
  | 'isValidValue'
  | 'isReferenced'
  | 'location'
> & { cssTexts: string[] };

const buildTagProcessorMocks = (): TemplateProcessorMock => {
  const addInterpolation: TaggedTemplateProcessor['addInterpolation'] = jest.fn(
    () => 'id'
  );
  const cssTexts: string[] = [];

  return {
    addInterpolation,
    extractRules: ((_: ValueCache, cssText: string) => {
      cssTexts.push(cssText);
      return {};
    }) as TaggedTemplateProcessor['extractRules'],
    isValidValue: ((value: unknown): value is Value => {
      return Boolean(value) || !value;
    }) as TaggedTemplateProcessor['isValidValue'],
    isReferenced: true,
    location: null,
    cssTexts,
  };
};

describe('templateProcessor unit parsing', () => {
  it('matches % unit at the start of following text', () => {
    const tagProcessor = buildTagProcessorMocks();
    const template = [
      buildTemplateElement(''),
      buildFunctionExpressionValue(),
      buildTemplateElement('%;'),
    ];

    templateProcessor(
      tagProcessor as TaggedTemplateProcessor,
      template,
      new Map(),
      'var'
    );

    expect(tagProcessor.addInterpolation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'value' }),
      '',
      'value',
      '%'
    );
    expect(tagProcessor.cssTexts[0]).toBe('var(--id);');
  });

  it('does not overmatch word-like suffixes for units', () => {
    const suffixes = ['pxa', 'px_'];

    suffixes.forEach((suffix) => {
      const tagProcessor = buildTagProcessorMocks();
      const template = [
        buildTemplateElement(''),
        buildFunctionExpressionValue(),
        buildTemplateElement(suffix),
      ];

      templateProcessor(
        tagProcessor as TaggedTemplateProcessor,
        template,
        new Map(),
        'var'
      );

      expect(tagProcessor.addInterpolation).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'value' }),
        '',
        'value'
        // unit is intentionally undefined here
      );
      expect(tagProcessor.cssTexts[0]).toBe(`var(--id)${suffix}`);
    });
  });

  it('continues to match word units like px when bounded', () => {
    const tagProcessor = buildTagProcessorMocks();
    const template = [
      buildTemplateElement(''),
      buildFunctionExpressionValue(),
      buildTemplateElement('px;'),
    ];

    templateProcessor(
      tagProcessor as TaggedTemplateProcessor,
      template,
      new Map(),
      'var'
    );

    expect(tagProcessor.addInterpolation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'value' }),
      '',
      'value',
      'px'
    );
    expect(tagProcessor.cssTexts[0]).toBe('var(--id);');
  });
});
