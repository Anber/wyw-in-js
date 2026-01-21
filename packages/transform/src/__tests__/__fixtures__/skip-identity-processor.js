const { BaseProcessor } = require('@wyw-in-js/processor-utils');

class SkipIdentityProcessor {
  constructor() {
    throw BaseProcessor.SKIP;
  }
}

module.exports = { default: SkipIdentityProcessor };
