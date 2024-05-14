import type { NextConfig } from 'next';
import type { LoaderOptions } from '@wyw-in-js/webpack-loader';
import { resolve } from 'import-meta-resolve';

export type WywOptions = Pick<LoaderOptions, 'preprocessor' | 'sourceMap'>;

const extensions = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
];

function hasCorectExtension(fileName: string) {
  return extensions.some((ext) => fileName.endsWith(ext));
}

function requireResolve(pathname: string) {
  const res = resolve(pathname, import.meta.url);
  return res.replaceAll('file://', '');
}

export default function withWywInJs(
  nextConfig: NextConfig,
  wywLoaderOptions?: WywOptions
) {
  if (process.env.TURBOPACK === '1') {
    // eslint-disable-next-line no-console
    console.log(
      `\x1B[33mTurbo mode is not supported yet. Please disable it by removing the "--turbo" flag from your "next dev" command to use WyW-in-JS.\x1B[39m`
    );
    return nextConfig;
  }

  const webpack: Exclude<NextConfig['webpack'], undefined> = (
    webpackConfig,
    context
  ) => {
    const loaderOptions = {
      ...wywLoaderOptions,
      nextjsConfig: {
        placeholderCssFile: requireResolve('../nextjs.wyw-in-js.css'),
        outputCss: true, // dev || hasAppDir || !isServer,
        async asyncResolve(token: string) {
          // Using the same stub file as "next/font". Should be updated in future to
          // use it's own stub depdending on the actual usage.
          if (token.startsWith('__barrel_optimize__')) {
            return requireResolve('../next-font');
          }
          // Need to point to the react from node_modules during eval time.
          // Otherwise, next makes it point to its own version of react that
          // has a lot of RSC specific logic which is not actually needed.
          if (
            token.startsWith('@babel') ||
            token.startsWith('react') ||
            token.startsWith('next')
          ) {
            return requireResolve(token);
          }
          if (token === 'next/image') {
            return requireResolve('../next-image');
          }
          if (token.startsWith('next/font')) {
            return requireResolve('../next-font');
          }
          return null;
        },
      },
      babelOptions: {
        presets: ['next/babel'],
      },
    };

    webpackConfig.module.rules.unshift({
      enforce: 'post',
      test(filename: string) {
        return hasCorectExtension(filename);
      },
      use: [
        {
          loader: requireResolve('@wyw-in-js/webpack-loader'),
          options: loaderOptions,
        },
      ],
    });

    webpackConfig.module.rules.unshift({
      enforce: 'pre',
      test(filename: string) {
        return filename.endsWith('nextjs.wyw-in-js.css');
      },
      use: requireResolve('../css-loader'),
    });

    if (typeof nextConfig.webpack === 'function') {
      return nextConfig.webpack(webpackConfig, context);
    }
    return webpackConfig;
  };

  return {
    ...nextConfig,
    webpack,
  };
}
