// @ts-check

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const colors = require('picocolors');
const prettier = require('prettier');
const { build } = require('vite');
const wyw = require('@wyw-in-js/vite');

const PKG_DIR = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function buildArtefact(outDir, pluginOptions) {
  await build({
    build: {
      manifest: true,
      outDir,
      cssMinify: false,
    },
    configFile: false,
    resolve: {
      alias: {
        '@': path.resolve(PKG_DIR, 'src'),
      },
    },
    plugins: [pluginOptions ? wyw.default(pluginOptions) : wyw.default()],
  });
}

async function buildPreserveModulesArtefact(outDir, format) {
  await build({
    build: {
      outDir,
      cssCodeSplit: true,
      cssMinify: false,
      lib: {
        entry: path.resolve(PKG_DIR, 'src/preserve-modules/index.ts'),
        formats: [format],
      },
      rollupOptions: {
        output: {
          assetFileNames: '[name][extname]',
          preserveModules: true,
          preserveModulesRoot: path.resolve(PKG_DIR, 'src/preserve-modules'),
        },
      },
    },
    configFile: false,
    plugins: [wyw.default({ preserveCssPaths: true })],
  });
}

async function getCSSFromManifest(outDir) {
  const manifestPath = path.resolve(outDir, '.vite', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  if (!manifest['index.html']) {
    throw new Error('No index.html in manifest');
  }

  if (!manifest['index.html'].css) {
    throw new Error('No CSS in manifest');
  }

  if (manifest['index.html'].css.length !== 1) {
    throw new Error('More than one CSS in manifest');
  }

  const cssFilePath = path.resolve(outDir, manifest['index.html'].css[0]);
  const cssSnapshot = await fs.readFile(cssFilePath, 'utf-8');

  return prettier.format(cssSnapshot, {
    parser: 'css',
  });
}

async function assertFileMatches(filePath, pattern) {
  const contents = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  if (!pattern.test(contents)) {
    throw new Error(`${path.relative(PKG_DIR, filePath)} does not match ${pattern}`);
  }
}

async function assertFileDoesNotContain(filePath, text) {
  const contents = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  if (contents.includes(text)) {
    throw new Error(`${path.relative(PKG_DIR, filePath)} unexpectedly contains ${text}`);
  }
}

async function listFilesRecursively(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.resolve(dirPath, entry.name);

      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath);
      }

      return [entryPath];
    })
  );

  return files.flat();
}

async function findFileMatching(dirPath, predicate) {
  const files = await listFilesRecursively(dirPath);

  for (const filePath of files) {
    const contents = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    if (predicate(filePath, contents)) {
      return filePath;
    }
  }

  throw new Error(`No matching file found under ${path.relative(PKG_DIR, dirPath)}`);
}

async function assertCjsModuleLoads(filePath) {
  const script = `
    require.extensions['.css'] = () => {};
    const mod = require(process.argv[1]);
    if (!mod || typeof mod.rootClass !== 'string') {
      throw new Error('Missing rootClass export');
    }
    if (!mod || typeof mod.buttonClass !== 'string') {
      throw new Error('Missing buttonClass export');
    }
    if (!mod || mod.plainValue !== 'plain') {
      throw new Error('Unexpected plainValue export');
    }
  `;

  await execFileAsync(process.execPath, ['-e', script, filePath], {
    cwd: PKG_DIR,
  });
}

async function main() {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  const outDir = path.resolve(PKG_DIR, 'dist');
  const testCases = [
    {
      name: 'default',
      fixturePath: path.resolve(PKG_DIR, 'fixture.css'),
    },
    {
      name: 'keepComments',
      fixturePath: path.resolve(PKG_DIR, 'fixture.keep-comments.css'),
      pluginOptions: { keepComments: true },
    },
  ];

  for (const testCase of testCases) {
    console.log(colors.blue('Running case:'), testCase.name);
    await fs.rm(outDir, { recursive: true, force: true });

    await buildArtefact(outDir, testCase.pluginOptions);

    const cssOutput = normalizeLineEndings(
      await getCSSFromManifest(outDir)
    );
    const cssFixture = normalizeLineEndings(
      await fs.readFile(testCase.fixturePath, 'utf-8')
    );

    if (cssOutput !== cssFixture) {
      console.log(colors.red(`[${testCase.name}] Output CSS:`));
      console.log(cssOutput);
      console.log(colors.red(`[${testCase.name}] Expected CSS:`));
      console.log(cssFixture);

      throw new Error(`[${testCase.name}] CSS output does not match fixture`);
    }
  }

  const preserveModulesCases = [
    {
      format: 'es',
      name: 'preserveModules-es',
      outDir: path.resolve(PKG_DIR, 'dist-preserve-modules'),
      cssEdgePattern: /import ["']\.\/index\.wyw-in-js\.css["'];/,
      nestedCssEdgePattern: /import ["']\.\/(?:nested\/)+button\.wyw-in-js\.css["'];/,
    },
    {
      format: 'cjs',
      name: 'preserveModules-cjs',
      outDir: path.resolve(PKG_DIR, 'dist-preserve-modules-cjs'),
      cssEdgePattern: /require\(["']\.\/index\.wyw-in-js\.css["']\);/,
      nestedCssEdgePattern: /require\(["']\.\/(?:nested\/)+button\.wyw-in-js\.css["']\);/,
    },
  ];

  for (const preserveModulesCase of preserveModulesCases) {
    console.log(colors.blue('Running case:'), preserveModulesCase.name);
    await fs.rm(preserveModulesCase.outDir, { recursive: true, force: true });

    await buildPreserveModulesArtefact(
      preserveModulesCase.outDir,
      preserveModulesCase.format
    );

    const rootModulePath = await findFileMatching(
      preserveModulesCase.outDir,
      (filePath, contents) =>
        /\.(?:mjs|js)$/.test(filePath) &&
        contents.includes('rootClass') &&
        contents.includes('./index.wyw-in-js.css')
    );
    const nestedModulePath = await findFileMatching(
      preserveModulesCase.outDir,
      (filePath, contents) =>
        /\.(?:mjs|js)$/.test(filePath) &&
        contents.includes('button.wyw-in-js.css')
    );
    const plainModulePath = await findFileMatching(
      preserveModulesCase.outDir,
      (filePath, contents) =>
        /\.(?:mjs|js)$/.test(filePath) &&
        contents.includes('"plain"') &&
        !contents.includes('.css')
    );

    await assertFileMatches(
      rootModulePath,
      preserveModulesCase.cssEdgePattern
    );
    await assertFileMatches(
      nestedModulePath,
      preserveModulesCase.nestedCssEdgePattern
    );
    await assertFileDoesNotContain(
      plainModulePath,
      '.css'
    );
    await fs.access(
      path.resolve(preserveModulesCase.outDir, 'index.wyw-in-js.css')
    );
    await findFileMatching(
      preserveModulesCase.outDir,
      (filePath) => filePath.endsWith('button.wyw-in-js.css')
    );

    if (preserveModulesCase.format === 'cjs') {
      await assertCjsModuleLoads(rootModulePath);
    }
  }
}

main().then(
  () => {
    console.log(colors.green('✅ Vite E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
