export function readPackage(pkg, context) {
  const fields = ['dependencies', 'devDependencies'];
  for (const field of fields) {
    if (!pkg[field]) {
      continue;
    }

    for (const [name, version] of Object.entries(pkg[field])) {
      pkg[field][name] = version.replace(/^\D*/, '');
    }
  }

  return pkg;
}
