import path from 'node:path';
import { fileURLToPath } from 'node:url';

import colors from 'picocolors';
import { createServer } from 'vite';

import wyw from '@wyw-in-js/vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');

const assertTransformed = (result, label) => {
  if (!result?.code || typeof result.code !== 'string') {
    throw new Error(`${label} was not transformed`);
  }
};

const main = async () => {
  const server = await createServer({
    configFile: false,
    root: PKG_DIR,
    logLevel: 'error',
    server: {
      middlewareMode: 'ssr',
      hmr: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(PKG_DIR, 'src'),
      },
    },
    plugins: [wyw()],
  });

  try {
    const resolvedIndex = await server.pluginContainer.resolveId('/index.html');
    if (!resolvedIndex) {
      throw new Error('Failed to resolve /index.html in dev mode');
    }

    const transformed = await server.transformRequest('/src/index.ts');
    assertTransformed(transformed, '/src/index.ts');
    if (!transformed.code.includes('classA')) {
      throw new Error(
        '/src/index.ts transformed code does not contain expected symbol "classA"'
      );
    }
  } finally {
    await server.close();
  }
};

main().then(
  () => {
    console.log(colors.green('✅ Vite dev smoke passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
