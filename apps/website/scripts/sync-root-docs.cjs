/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const websiteRoot = path.resolve(__dirname, '..');
const contentDir = path.join(websiteRoot, 'content');

const sources = [
  {
    src: path.join(repoRoot, 'README.md'),
    dest: path.join(contentDir, 'README.md'),
  },
  {
    src: path.join(repoRoot, 'CHANGELOG.md'),
    dest: path.join(contentDir, 'CHANGELOG.md'),
  },
];

fs.mkdirSync(contentDir, { recursive: true });

for (const { src, dest } of sources) {
  if (!fs.existsSync(src)) {
    console.error(`Missing source file: ${src}`);
    process.exitCode = 1;
    continue;
  }

  fs.copyFileSync(src, dest);
}

