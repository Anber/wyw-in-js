import type { Configuration, RuleSetRule } from 'webpack';

import { withWyw } from '../index';

describe('withWyw', () => {
  it('injects @wyw-in-js/webpack-loader into Next transpile rules', () => {
    const config: Configuration = {
      module: {
        rules: [
          {
            use: [{ loader: 'next-swc-loader' }],
          },
        ],
      },
    };

    const nextConfig = withWyw();

    const result = nextConfig.webpack!(config, { dev: true } as any);
    const use = (result.module!.rules![0] as RuleSetRule).use as any[];

    expect(use).toHaveLength(2);
    expect(use[1].loader).toContain('webpack-loader');
  });

  it('converts loader+options rules to use[] when injecting', () => {
    const config: Configuration = {
      module: {
        rules: [
          {
            loader: 'next-swc-loader',
            options: {
              some: 'option',
            },
          } as any,
        ],
      },
    };

    const nextConfig = withWyw();

    const result = nextConfig.webpack!(config, { dev: true } as any);
    const rule = result.module!.rules![0] as any;

    expect(rule.loader).toBeUndefined();
    expect(rule.options).toBeUndefined();
    expect(rule.use).toHaveLength(2);
    expect(rule.use[0].loader).toContain('next-swc-loader');
    expect(rule.use[0].options).toEqual({ some: 'option' });
    expect(rule.use[1].loader).toContain('webpack-loader');
  });

  it('keeps generated class names stable in .wyw-in-js.module.css', () => {
    const originalGetLocalIdent = (
      _context: unknown,
      _localIdentName: string,
      localName: string
    ) => `hashed_${localName}`;

    const config: Configuration = {
      module: {
        rules: [
          {
            oneOf: [
              {
                use: [{ loader: 'next-swc-loader' }],
              },
              {
                test: /\.module\.css$/,
                use: [
                  {
                    loader: 'css-loader',
                    options: {
                      modules: {
                        mode: 'pure',
                        getLocalIdent: originalGetLocalIdent,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const nextConfig = withWyw();
    nextConfig.webpack!(config, { dev: true } as any);

    const rules = (config.module!.rules![0] as RuleSetRule).oneOf! as any[];
    expect(rules).toHaveLength(3);

    const wywCssRule = rules[1];
    expect(String(wywCssRule.test)).toContain('wyw-in-js');
    expect(wywCssRule.sideEffects).toBe(true);

    const { modules } = wywCssRule.use[0].options;
    expect(modules.mode).toBe('global');

    const patched = modules.getLocalIdent;

    expect(
      patched({ resourcePath: '/x/file.wyw-in-js.module.css' }, 'name', 'foo')
    ).toBe('foo');

    const originalCssRule = rules[2];
    expect(
      originalCssRule.use[0].options.modules.getLocalIdent(
        { resourcePath: '/x/file.module.css' },
        'name',
        'foo'
      )
    ).toBe('hashed_foo');
  });
});
