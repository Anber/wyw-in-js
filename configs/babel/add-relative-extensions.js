const fs = require('fs');
const path = require('path');

const DEFAULT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const KNOWN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.txt',
  '.md',
  '.wasm',
  '.node',
]);

const resolveCache = new Map();
const packageCache = new Map();

const isRelative = (value) => value.startsWith('./') || value.startsWith('../');
const hasExtension = (value) => KNOWN_EXTS.has(path.extname(value));
const hasQueryOrHash = (value) => value.includes('?') || value.includes('#');

const resolveWithExtensions = (basePath) => {
  for (const ext of DEFAULT_EXTS) {
    if (fs.existsSync(`${basePath}${ext}`)) {
      return true;
    }
  }
  return false;
};

const resolveIndexWithExtensions = (basePath) => {
  for (const ext of DEFAULT_EXTS) {
    if (fs.existsSync(path.join(basePath, `index${ext}`))) {
      return true;
    }
  }
  return false;
};

const findPackageJson = (filename) => {
  if (!filename) {
    return null;
  }
  let dir = path.dirname(filename);
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
};

const getOutputExtension = (filename) => {
  if (!filename) {
    return '.js';
  }
  const pkgPath = findPackageJson(filename);
  if (!pkgPath) {
    return '.js';
  }
  if (packageCache.has(pkgPath)) {
    return packageCache.get(pkgPath);
  }
  let extension = '.js';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const exportEntry = pkg?.exports?.['.'];
    const exportDefault = exportEntry?.default || exportEntry?.import;
    const main = pkg?.main;
    const target = typeof exportDefault === 'string' ? exportDefault : main;
    if (typeof target === 'string' && target.endsWith('.mjs')) {
      extension = '.mjs';
    }
  } catch {
    extension = '.js';
  }
  packageCache.set(pkgPath, extension);
  return extension;
};

const rewriteSpecifier = (value, filename) => {
  if (!value || !isRelative(value) || hasExtension(value) || hasQueryOrHash(value)) {
    return null;
  }

  const cacheKey = `${filename || 'unknown'}::${value}`;
  if (resolveCache.has(cacheKey)) {
    return resolveCache.get(cacheKey);
  }

  const outputExtension = getOutputExtension(filename);
  let rewritten = `${value}${outputExtension}`;
  if (filename) {
    const baseDir = path.dirname(filename);
    const resolved = path.resolve(baseDir, value);

    try {
      if (resolveWithExtensions(resolved)) {
        rewritten = `${value}${outputExtension}`;
      } else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        rewritten = `${value.replace(/\/$/, '')}/index${outputExtension}`;
      } else if (resolveIndexWithExtensions(resolved)) {
        rewritten = `${value.replace(/\/$/, '')}/index${outputExtension}`;
      }
    } catch {
      // ignore fs errors and fall back to `${value}.js`
    }
  }

  resolveCache.set(cacheKey, rewritten);
  return rewritten;
};

const maybeRewriteSource = (node, filename) => {
  if (!node || node.type !== 'StringLiteral') {
    return;
  }
  const rewritten = rewriteSpecifier(node.value, filename);
  if (rewritten && rewritten !== node.value) {
    node.value = rewritten;
  }
};

module.exports = () => ({
  name: 'wyw-add-relative-extensions',
  visitor: {
    ImportDeclaration(path, state) {
      maybeRewriteSource(path.node.source, state.file?.opts?.filename);
    },
    ExportNamedDeclaration(path, state) {
      maybeRewriteSource(path.node.source, state.file?.opts?.filename);
    },
    ExportAllDeclaration(path, state) {
      maybeRewriteSource(path.node.source, state.file?.opts?.filename);
    },
    ImportExpression(path, state) {
      if (path.node.source && path.node.source.type === 'StringLiteral') {
        maybeRewriteSource(path.node.source, state.file?.opts?.filename);
      }
    },
  },
});
