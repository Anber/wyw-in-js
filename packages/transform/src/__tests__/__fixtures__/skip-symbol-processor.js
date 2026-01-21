class SkipSymbolProcessor {
  constructor() {
    throw Symbol('skip');
  }
}

module.exports = { default: SkipSymbolProcessor };
