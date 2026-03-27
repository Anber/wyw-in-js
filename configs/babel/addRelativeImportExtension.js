const fs = require('fs');
const path = require('path');
const { posix } = path;

const passthroughExtensions = new Set([
  '.cjs',
  '.css',
  '.js',
  '.json',
  '.mjs',
  '.node',
  '.wasm',
]);

const sourceExtensions = new Set(['.cts', '.jsx', '.mts', '.ts', '.tsx']);
const resolvableSourceExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

function resolveSourceSpecifier(filename, pathname) {
  const basedir = path.dirname(filename);
  const resolvedBase = path.resolve(basedir, pathname);

  for (const extension of resolvableSourceExtensions) {
    if (fs.existsSync(`${resolvedBase}${extension}`)) {
      return 'file';
    }
  }

  for (const extension of resolvableSourceExtensions) {
    if (fs.existsSync(path.join(resolvedBase, `index${extension}`))) {
      return 'index';
    }
  }

  return null;
}

function rewriteSpecifier(specifier, extension) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return specifier;
  }

  const suffixIndex = specifier.search(/[?#]/);
  const pathname =
    suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : specifier.slice(suffixIndex);

  const currentExtension = posix.extname(pathname);

  if (!currentExtension) {
    const resolvedKind = rewriteSpecifier.filename
      ? resolveSourceSpecifier(rewriteSpecifier.filename, pathname)
      : null;

    if (resolvedKind === 'file') {
      return `${pathname}${extension}${suffix}`;
    }

    if (resolvedKind === 'index') {
      return `${pathname}/index${extension}${suffix}`;
    }

    return `${pathname}${extension}${suffix}`;
  }

  if (sourceExtensions.has(currentExtension)) {
    return `${pathname.slice(0, -currentExtension.length)}${extension}${suffix}`;
  }

  if (passthroughExtensions.has(currentExtension)) {
    return specifier;
  }

  const resolvedKind = rewriteSpecifier.filename
    ? resolveSourceSpecifier(rewriteSpecifier.filename, pathname)
    : null;

  if (resolvedKind === 'file') {
    return `${pathname}${extension}${suffix}`;
  }

  if (resolvedKind === 'index') {
    return `${pathname}/index${extension}${suffix}`;
  }

  return `${pathname}${extension}${suffix}`;
}

module.exports = function addRelativeImportExtension() {
  return {
    name: 'add-relative-import-extension',
    visitor: {
      CallExpression(path, state) {
        if (path.node.callee.type !== 'Import') {
          return;
        }

        const [specifier] = path.node.arguments;
        if (!specifier || specifier.type !== 'StringLiteral') {
          return;
        }

        rewriteSpecifier.filename = state.file.opts.filename;
        specifier.value = rewriteSpecifier(
          specifier.value,
          state.opts.extension
        );
      },
      ExportAllDeclaration(path, state) {
        rewriteSpecifier.filename = state.file.opts.filename;
        path.node.source.value = rewriteSpecifier(
          path.node.source.value,
          state.opts.extension
        );
      },
      ExportNamedDeclaration(path, state) {
        if (!path.node.source) {
          return;
        }

        rewriteSpecifier.filename = state.file.opts.filename;
        path.node.source.value = rewriteSpecifier(
          path.node.source.value,
          state.opts.extension
        );
      },
      ImportDeclaration(path, state) {
        rewriteSpecifier.filename = state.file.opts.filename;
        path.node.source.value = rewriteSpecifier(
          path.node.source.value,
          state.opts.extension
        );
      },
    },
  };
};
