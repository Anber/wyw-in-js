import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import colors from 'picocolors';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate a TCP port');
  }

  return address.port;
};

const cleanupGeneratedCss = async () => {
  const appDir = path.resolve(PKG_DIR, 'app');

  const walk = async (dir) => {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.resolve(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.wyw-in-js.module.css')
        ) {
          await fs.rm(fullPath, { force: true });
        }
      })
    );
  };

  await walk(appDir);
};

const startDevServer = async () => {
  await fs.rm(path.resolve(PKG_DIR, '.next'), { recursive: true, force: true });
  await cleanupGeneratedCss();

  const nextPackageJson = require.resolve('next/package.json', {
    paths: [PKG_DIR],
  });
  const nextBin = path.resolve(
    path.dirname(nextPackageJson),
    'dist',
    'bin',
    'next'
  );
  const port = await getFreePort();
  const logs = [];

  const child = spawn(
    process.execPath,
    [nextBin, 'dev', '--turbopack', '-H', '127.0.0.1', '-p', String(port)],
    {
      cwd: PKG_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const appendLog = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    process.stdout.write(text);
  };
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);

  return {
    child,
    logs,
    url: `http://127.0.0.1:${port}`,
  };
};

const stopDevServer = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    delay(5000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
};

const fetchWithRetries = async (url, child, logs) => {
  let lastError = null;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Next dev exited before serving ${url}\n${logs.join('')}`
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.text();
      }

      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for ${url}: ${lastError?.message ?? 'unknown error'}`
  );
};

const runDevSmoke = async () => {
  const devServer = await startDevServer();

  try {
    const html = await fetchWithRetries(
      devServer.url,
      devServer.child,
      devServer.logs
    );

    if (!html.includes('Hello WyW + Next.js')) {
      throw new Error('Expected rendered page to include the app heading');
    }
  } finally {
    await stopDevServer(devServer.child);
  }
};

const readCssOutput = async () => {
  const cssFile = path.resolve(
    PKG_DIR,
    'app',
    'styles.wyw-in-js.module.css'
  );

  try {
    return await fs.readFile(cssFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`No generated CSS file found at ${cssFile}`);
    }

    throw error;
  }
};

const assertMatches = (css, pattern, label) => {
  if (!pattern.test(css)) {
    throw new Error(`Expected CSS output to include ${label}`);
  }
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  try {
    await runDevSmoke();

    const cssOutput = await readCssOutput();

    assertMatches(
      cssOutput,
      /border:\s*1px\s*solid\s*(blue|#00f|#0000ff)/i,
      'border'
    );
    assertMatches(cssOutput, /height:\s*100px/i, 'height');
    assertMatches(cssOutput, /width:\s*200px/i, 'width');
    assertMatches(cssOutput, /font-size:\s*18px/i, 'font-size');
    assertMatches(cssOutput, /color:\s*tomato/i, 'color');
  } finally {
    await cleanupGeneratedCss();
  }
};

main().then(
  () => {
    console.log(colors.green('✅ Next Turbopack E2E test passed'));
    process.exit(0);
  },
  async (error) => {
    console.error(colors.red('Error:'), error);
    await cleanupGeneratedCss();
    process.exit(1);
  }
);
