import * as path from 'path';
import {
  compile,
  middleware,
  prefixer,
  serialize,
  stringify,
  tokenize,
  RULESET,
} from 'stylis';
import type { Middleware } from 'stylis';

import type { Options } from '../../types';

const POSIX_SEP = path.posix.sep;

export function transformUrl(
  url: string,
  outputFilename: string,
  sourceFilename: string,
  platformPath: typeof path = path
) {
  // Replace asset path with new path relative to the output CSS
  const relative = platformPath.relative(
    platformPath.dirname(outputFilename),
    // Get the absolute path to the asset from the path relative to the JS file
    platformPath.resolve(platformPath.dirname(sourceFilename), url)
  );

  if (platformPath.sep === POSIX_SEP) {
    return relative;
  }

  return relative.split(platformPath.sep).join(POSIX_SEP);
}

/**
 * Stylis plugin that mimics :global() selector behavior from Stylis v3.
 */
export const stylisGlobalPlugin: Middleware = (element) => {
  function getGlobalSelectorModifiers(value: string) {
    const match = value.match(/(&\f( )?)?:global\(/);

    if (match === null) {
      throw new Error(
        `Failed to match :global() selector in "${value}". Please report a bug if it happens.`
      );
    }

    const [, baseSelector, spaceDelimiter] = match;

    return {
      includeBaseSelector: !!baseSelector,
      includeSpaceDelimiter: !!spaceDelimiter,
    };
  }

  switch (element.type) {
    case RULESET:
      if (typeof element.props === 'string') {
        if (process.env.NODE_ENV !== 'production') {
          throw new Error(
            `"element.props" has type "string" (${JSON.stringify(
              element.props,
              null,
              2
            )}), it's not expected. Please report a bug if it happens.`
          );
        }

        return;
      }

      Object.assign(element, {
        props: element.props.map((cssSelector) => {
          // Avoids calling tokenize() on every string
          if (!cssSelector.includes(':global(')) {
            return cssSelector;
          }

          if (element.children.length === 0) {
            Object.assign(element, {
              global: getGlobalSelectorModifiers(element.value),
            });
            return cssSelector;
          }

          const { includeBaseSelector, includeSpaceDelimiter } =
            (
              element.parent as unknown as
                | (Element & {
                    global: ReturnType<typeof getGlobalSelectorModifiers>;
                  })
                | undefined
            )?.global || getGlobalSelectorModifiers(element.value);

          const tokens = tokenize(cssSelector);
          let selector = '';

          for (let i = 0, len = tokens.length; i < len; i++) {
            const token = tokens[i];

            //
            // Match for ":global("
            if (token === ':' && tokens[i + 1] === 'global') {
              //
              // Match for ":global()"
              if (tokens[i + 2] === '()') {
                selector = [
                  ...tokens.slice(i + 4),
                  includeSpaceDelimiter ? ' ' : '',
                  ...(includeBaseSelector ? tokens.slice(0, i - 1) : []),
                  includeSpaceDelimiter ? '' : ' ',
                ].join('');

                break;
              }

              //
              // Match for ":global(selector)"
              selector = [
                tokens[i + 2].slice(1, -1),
                includeSpaceDelimiter ? ' ' : '',
                ...(includeBaseSelector ? tokens.slice(0, i - 1) : []),
                includeSpaceDelimiter ? '' : ' ',
              ].join('');

              break;
            }
          }

          return selector;
        }),
      });

      break;

    default:
  }
};

export function createStylisUrlReplacePlugin(
  filename: string,
  outputFilename: string | undefined
): Middleware {
  return (element) => {
    if (element.type === 'decl' && outputFilename) {
      // When writing to a file, we need to adjust the relative paths inside url(..) expressions.
      // It'll allow css-loader to resolve an imported asset properly.
      // eslint-disable-next-line no-param-reassign
      element.return = element.value.replace(
        /\b(url\((["']?))(\.[^)]+?)(\2\))/g,
        (match, p1, p2, p3, p4) =>
          p1 + transformUrl(p3, outputFilename, filename) + p4
      );
    }
  };
}

export function createStylisPreprocessor(options: Options) {
  function stylisPreprocess(selector: string, text: string): string {
    const compiled = compile(`${selector} {${text}}\n`);

    return serialize(
      compiled,
      middleware([
        createStylisUrlReplacePlugin(options.filename, options.outputFilename),
        stylisGlobalPlugin,
        prefixer,
        stringify,
      ])
    );
  }

  return stylisPreprocess;
}
