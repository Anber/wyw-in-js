import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!process.env.SSL_CERT_FILE && process.platform === 'darwin') {
  const certBundle = '/etc/ssl/cert.pem';
  if (existsSync(certBundle)) {
    process.env.SSL_CERT_FILE = certBundle;
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node ./scripts/run-turbo.mjs <turbo args...>');
  process.exit(1);
}

const result = spawnSync('turbo', args, {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
