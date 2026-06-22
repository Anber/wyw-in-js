import { execFileSync, spawn } from 'node:child_process';
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
const MIN_NEXT_VERSION = { major: 16, minor: 2 };

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

const getNextBin = () => {
  const nextPackageJson = require.resolve('next/package.json', {
    paths: [PKG_DIR],
  });

  return path.resolve(path.dirname(nextPackageJson), 'dist', 'bin', 'next');
};

const getNextVersion = () => {
  const nextPackageJson = require.resolve('next/package.json', {
    paths: [PKG_DIR],
  });
  const { version } = require(nextPackageJson);
  const [majorPart, minorPart] = version.split('.');

  return {
    major: Number.parseInt(majorPart, 10),
    minor: Number.parseInt(minorPart, 10),
    version,
  };
};

const assertSupportedNextVersion = () => {
  const { major, minor, version } = getNextVersion();
  const isSupported =
    major > MIN_NEXT_VERSION.major ||
    (major === MIN_NEXT_VERSION.major && minor >= MIN_NEXT_VERSION.minor);

  if (!isSupported) {
    throw new Error(
      `Expected Next.js ${MIN_NEXT_VERSION.major}.${MIN_NEXT_VERSION.minor}.x or newer, got ${version}`
    );
  }
};

const runProductionBuild = async () => {
  await fs.rm(path.resolve(PKG_DIR, '.next'), { recursive: true, force: true });
  await cleanupGeneratedCss();

  execFileSync(process.execPath, [getNextBin(), 'build'], {
    cwd: PKG_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: 'inherit',
  });
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
  const cssFiles = [];

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
        } else if (entry.isFile() && entry.name.endsWith('.css')) {
          cssFiles.push(fullPath);
        }
      })
    );
  };

  await walk(path.resolve(PKG_DIR, '.next'));

  if (cssFiles.length === 0) {
    throw new Error('No CSS assets emitted by Next build');
  }

  const contents = await Promise.all(
    cssFiles.map((file) => fs.readFile(file, 'utf8'))
  );

  return contents.join('\n');
};

const assertMatches = (css, pattern, label) => {
  if (!pattern.test(css)) {
    throw new Error(`Expected CSS output to include ${label}`);
  }
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);
  assertSupportedNextVersion();

  try {
    await runProductionBuild();

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

    await runDevSmoke();
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
