import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const fixturesDir = path.join(root, 'fixtures', 'big-barrel', 'dist');
const leafDir = path.join(fixturesDir, 'leaf');
const groupsDir = path.join(fixturesDir, 'groups');
const generatedDir = path.join(root, 'src', 'generated');
const consumersDir = path.join(generatedDir, 'consumers');

const exportsCount = Number(process.env.WYW_REPRO_EXPORTS ?? '320');
const consumerCount = Number(process.env.WYW_REPRO_CONSUMERS ?? '96');
const groupSize = Number(process.env.WYW_REPRO_GROUP_SIZE ?? '16');

const ensurePositive = (name, value) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
};

ensurePositive('WYW_REPRO_EXPORTS', exportsCount);
ensurePositive('WYW_REPRO_CONSUMERS', consumerCount);
ensurePositive('WYW_REPRO_GROUP_SIZE', groupSize);

fs.rmSync(path.join(root, 'fixtures'), { force: true, recursive: true });
fs.rmSync(generatedDir, { force: true, recursive: true });

fs.mkdirSync(leafDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(consumersDir, { recursive: true });

const groupCount = Math.ceil(exportsCount / groupSize);
const groupExports = Array.from({ length: groupCount }, () => []);

for (let i = 0; i < exportsCount; i += 1) {
  const exportName = `token${i}`;
  const leafFile = `leaf-${i}.js`;
  const color = `#${((i * 2654435761) % 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;

  fs.writeFileSync(
    path.join(leafDir, leafFile),
    [
      '// Auto-generated built leaf module.',
      `export const ${exportName} = '${color}';`,
      '',
    ].join('\n')
  );

  groupExports[Math.floor(i / groupSize)].push({
    exportName,
    leafFile,
  });
}

for (let i = 0; i < groupExports.length; i += 1) {
  const lines = ['// Auto-generated barrel group.'];
  groupExports[i].forEach(({ exportName, leafFile }) => {
    lines.push(`export { ${exportName} } from '../leaf/${leafFile}';`);
  });
  lines.push('');
  fs.writeFileSync(
    path.join(groupsDir, `group-${i}.js`),
    `${lines.join('\n')}\n`
  );
}

const barrelLines = [
  '// Auto-generated top-level built barrel.',
  `export const barrelVersion = '${exportsCount}:${consumerCount}:${groupSize}';`,
];
for (let i = 0; i < groupExports.length; i += 1) {
  barrelLines.push(`export * from './groups/group-${i}.js';`);
}
barrelLines.push('');
fs.writeFileSync(path.join(fixturesDir, 'index.js'), `${barrelLines.join('\n')}\n`);

const indexLines = [
  `import { barrelVersion } from 'big-barrel-package';`,
];
const classRefs = [];

for (let i = 0; i < consumerCount; i += 1) {
  const exportName = `token${i % exportsCount}`;
  const modName = `consumer-${i}`;
  const className = `cls${i}`;
  classRefs.push(className);

  fs.writeFileSync(
    path.join(consumersDir, `${modName}.tsx`),
    [
      `import { css } from '@wyw-in-js/template-tag-syntax';`,
      `import { ${exportName} } from 'big-barrel-package';`,
      '',
      `export const ${className} = css\``,
      `  color: \${${exportName}};`,
      `  border-color: \${${exportName}};`,
      `\`;`,
      '',
    ].join('\n')
  );

  indexLines.push(
    `import { ${className} } from './consumers/${modName}';`
  );
}

indexLines.push('');
indexLines.push(`export const reproMeta = { barrelVersion, exportsCount: ${exportsCount}, consumerCount: ${consumerCount} };`);
indexLines.push(`export const classes = [${classRefs.join(', ')}];`);
indexLines.push('');

fs.writeFileSync(path.join(generatedDir, 'index.ts'), `${indexLines.join('\n')}\n`);
