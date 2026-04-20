import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const perfDir = path.join(root, 'src', '__perf__');
const consumersDir = path.join(perfDir, 'consumers');

const args = process.argv.slice(2);
const exportsCount = Number(args[0] ?? '500');

if (!Number.isFinite(exportsCount) || exportsCount <= 0) {
  throw new Error(`Invalid exportsCount: ${exportsCount}`);
}

fs.rmSync(perfDir, { force: true, recursive: true });
fs.mkdirSync(consumersDir, { recursive: true });

const bigLines = [];
bigLines.push(`// Auto-generated. Do not edit manually.`);
bigLines.push(`// Exports: ${exportsCount}`);
bigLines.push('');
for (let i = 0; i < exportsCount; i += 1) {
  bigLines.push(`export const color${i} = '#${(i % 0xffffff)
    .toString(16)
    .padStart(6, '0')}';`);
}
bigLines.push('');
fs.writeFileSync(path.join(perfDir, 'big.ts'), `${bigLines.join('\n')}\n`);

const indexLines = [];
indexLines.push(`// Auto-generated. Do not edit manually.`);
indexLines.push('');

for (let i = 0; i < exportsCount; i += 1) {
  const fileBase = `mod${i}`;
  const relImport = `./consumers/${fileBase}`;

  indexLines.push(`import '${relImport}';`);

  const modLines = [];
  modLines.push(`// Auto-generated. Do not edit manually.`);
  modLines.push(`import { css } from '@wyw-in-js/template-tag-syntax';`);
  modLines.push(`import { color${i} } from '../big';`);
  modLines.push('');
  modLines.push(`export const cls${i} = css\`color: \${color${i}};\`;`);
  modLines.push('');

  fs.writeFileSync(
    path.join(consumersDir, `${fileBase}.tsx`),
    `${modLines.join('\n')}\n`
  );
}

fs.writeFileSync(path.join(perfDir, 'index.ts'), `${indexLines.join('\n')}\n`);

const entryLines = [];
entryLines.push(`import React from 'react';`);
entryLines.push(`import ReactDOM from 'react-dom/client';`);
entryLines.push(`import './index';`);
entryLines.push('');
entryLines.push(`const App = () => <div>perf</div>;`);
entryLines.push('');
entryLines.push(
  `ReactDOM.createRoot(document.getElementById('root')!).render(<App />);`
);
entryLines.push('');

fs.writeFileSync(path.join(perfDir, 'entry.tsx'), `${entryLines.join('\n')}\n`);

