import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

const ALIASES = new Map([
  ['@wyw-in-js/object-syntax', 'examples/object-syntax/src/index.ts'],
  ['@wyw-in-js/processor-utils', 'packages/processor-utils/src/index.ts'],
  ['@wyw-in-js/shared', 'packages/shared/src/index.ts'],
  ['@wyw-in-js/transform', 'packages/transform/src/index.ts'],
  ['@wyw-in-js/template-tag-syntax', 'examples/template-tag-syntax/src/index.ts'],
  ['@wyw-in-js/webpack-loader', 'packages/webpack-loader/src/index.ts'],
  ['@wyw-in-js/vite', 'packages/vite/src/index.ts'],
]);

const resolveAlias = (specifier) => {
  const mapped = ALIASES.get(specifier);
  if (!mapped) return null;
  return pathToFileURL(path.resolve(ROOT, mapped)).href;
};

export async function resolve(specifier, context, defaultResolve) {
  const alias = resolveAlias(specifier);
  if (alias) {
    return defaultResolve(alias, context, defaultResolve);
  }

  return defaultResolve(specifier, context, defaultResolve);
}
