/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const websiteRoot = path.resolve(__dirname, '..');
const contentDir = path.join(websiteRoot, 'content');

fs.mkdirSync(contentDir, { recursive: true });

syncReadme();
syncChangelog();

function syncReadme() {
  const src = path.join(repoRoot, 'README.md');
  const dest = path.join(contentDir, 'README.md');

  if (!fs.existsSync(src)) {
    console.error(`Missing source file: ${src}`);
    process.exitCode = 1;
    return;
  }

  fs.copyFileSync(src, dest);
}

function syncChangelog() {
  const packagesDir = path.join(repoRoot, 'packages');
  const dest = path.join(contentDir, 'CHANGELOG.md');

  const packageDirs = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDir, entry.name));

  const packages = packageDirs
    .map((pkgDir) => {
      const changelogPath = path.join(pkgDir, 'CHANGELOG.md');
      if (!fs.existsSync(changelogPath)) {
        return null;
      }

      const content = fs.readFileSync(changelogPath, 'utf8').trim();
      if (!content) {
        return null;
      }

      const match = /^#\s+(.+?)\s*$/m.exec(content);
      const name = match ? match[1] : path.basename(pkgDir);

      return { name, content };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const aggregated = [
    '# wyw-in-js',
    '',
    'Aggregated release notes for all published packages in the monorepo.',
    '',
    ...packages.flatMap((pkg) => [
      bumpMarkdownHeadings(pkg.content, 1),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n');

  fs.writeFileSync(dest, aggregated);
}

function bumpMarkdownHeadings(markdown, bumpBy) {
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceMarker = null;

  return lines
    .map((line) => {
      const fence = /^(```+|~~~+)/.exec(line);
      if (fence) {
        const marker = fence[1][0];
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (fenceMarker === marker) {
          inFence = false;
          fenceMarker = null;
        }
        return line;
      }

      if (inFence) {
        return line;
      }

      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!heading) {
        return line;
      }

      const level = Math.min(6, heading[1].length + bumpBy);
      return `${'#'.repeat(level)} ${heading[2]}`;
    })
    .join('\n');
}
