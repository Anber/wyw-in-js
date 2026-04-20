async function getReleaseLine(changeset) {
  const [firstLine, ...futureLines] = changeset.summary
    .split('\n')
    .map((line) => line.trimRight());

  let releaseLine = `- ${changeset.commit ? `${changeset.commit.slice(0, 7)}: ` : ''}${firstLine}`;

  if (futureLines.length > 0) {
    releaseLine += `\n${futureLines.map((line) => `  ${line}`).join('\n')}`;
  }

  return releaseLine;
}

async function getDependencyReleaseLine(_changesets, dependenciesUpdated) {
  if (dependenciesUpdated.length === 0) {
    return '';
  }

  const updatedDependenciesList = dependenciesUpdated
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((dependency) => `  - ${dependency.name}@${dependency.newVersion}`);

  return ['- Updated dependencies', ...updatedDependenciesList].join('\n');
}

module.exports = {
  getReleaseLine,
  getDependencyReleaseLine,
};
