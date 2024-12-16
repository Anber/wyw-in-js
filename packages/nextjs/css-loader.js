function wywCssLoader() {
  const callback = this.async();
  const resourceQuery = this.resourceQuery.slice(1);
  const { source } = JSON.parse(decodeURIComponent(resourceQuery));
  return callback(null, source.replaceAll('__IMP__', '!important'));
}

exports.default = wywCssLoader;
