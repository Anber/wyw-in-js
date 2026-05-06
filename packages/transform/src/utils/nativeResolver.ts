import fs from 'fs';
import path from 'path';

import { ResolverFactory, type NapiResolveOptions } from 'oxc-resolver';

import type {
  EvalResolverKind,
  OxcOptions,
  StrictOptions,
} from '@wyw-in-js/shared';

import { parseRequest } from './parseRequest';

const CJS_DEFAULT_CONDITIONS = ['require', 'node', 'default'] as const;
const ESM_DEFAULT_CONDITIONS = ['node', 'import', 'default'] as const;
const FALLBACK_EXTENSIONS = ['.json', '.node'] as const;

const resolverCache = new Map<string, ResolverFactory>();

export type NativeResolverParams = {
  conditionNames?: string[];
  extensions: StrictOptions['extensions'];
  importer: string;
  kind: EvalResolverKind;
  oxcOptions?: OxcOptions;
  specifier: string;
};

const unique = <T>(items: readonly T[]): T[] => Array.from(new Set(items));

export const expandNativeResolverConditions = (
  kind: EvalResolverKind,
  conditionNames?: readonly string[]
): string[] => {
  const defaults =
    kind === 'require' ? CJS_DEFAULT_CONDITIONS : ESM_DEFAULT_CONDITIONS;
  const names = conditionNames?.length ? conditionNames : ['...'];
  const result: string[] = [];

  names.forEach((name) => {
    if (name === '...') {
      defaults.forEach((condition) => result.push(condition));
      return;
    }

    result.push(name);
  });

  return unique(result);
};

const createResolverOptions = ({
  conditionNames,
  extensions,
  kind,
  oxcOptions,
}: Pick<
  NativeResolverParams,
  'conditionNames' | 'extensions' | 'kind' | 'oxcOptions'
>): NapiResolveOptions => {
  const configuredResolver = (oxcOptions?.resolver ?? {}) as NapiResolveOptions;
  const hasConfiguredTsconfig = Object.prototype.hasOwnProperty.call(
    configuredResolver,
    'tsconfig'
  );
  const configuredConditionNames = Array.isArray(
    configuredResolver.conditionNames
  )
    ? configuredResolver.conditionNames
    : undefined;
  const configuredExtensions = Array.isArray(configuredResolver.extensions)
    ? configuredResolver.extensions
    : [];

  return {
    ...configuredResolver,
    ...(hasConfiguredTsconfig ? {} : { tsconfig: 'auto' }),
    conditionNames: expandNativeResolverConditions(
      kind,
      conditionNames ?? configuredConditionNames
    ),
    extensions: unique([
      ...configuredExtensions,
      ...extensions,
      ...FALLBACK_EXTENSIONS,
    ]),
  };
};

const getResolver = (options: NapiResolveOptions): ResolverFactory => {
  const key = JSON.stringify(options);
  const cached = resolverCache.get(key);
  if (cached) return cached;

  const resolver = new ResolverFactory(options);
  resolverCache.set(key, resolver);
  return resolver;
};

const preferJsOverCjsForExtensionlessFileSpecifier = (
  specifier: string,
  resolved: string
): string => {
  if (
    (specifier.startsWith('.') || path.isAbsolute(specifier)) &&
    path.extname(specifier) === '' &&
    resolved.endsWith('.cjs') &&
    fs.existsSync(`${resolved.slice(0, -4)}.js`)
  ) {
    return `${resolved.slice(0, -4)}.js`;
  }

  return resolved;
};

export const resolveWithNativeResolver = ({
  conditionNames,
  extensions,
  importer,
  kind,
  oxcOptions,
  specifier,
}: NativeResolverParams): string => {
  const { filename, query, hash } = parseRequest(specifier);
  const options = createResolverOptions({
    conditionNames,
    extensions,
    kind,
    oxcOptions,
  });
  const resolver = getResolver(options);
  const result = resolver.resolveFileSync(importer, filename);

  if (!result.path) {
    throw new Error(result.error ?? `Cannot resolve module ${specifier}`);
  }

  const resolved = preferJsOverCjsForExtensionlessFileSpecifier(
    filename,
    result.path
  );
  const suffix = `${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;

  return `${resolved}${suffix}`;
};
