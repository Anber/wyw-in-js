const { TaggedTemplateProcessor } = require('@wyw-in-js/processor-utils');

class ProcessorOptionsProcessor extends TaggedTemplateProcessor {
  get asSelector() {
    return `.${this.className}`;
  }

  get value() {
    return this.astService.stringLiteral(
      this.options.processors?.processorOptionsTest?.runtimeClassName ??
        this.className
    );
  }

  addInterpolation() {
    throw new Error('ProcessorOptionsProcessor does not handle interpolations');
  }

  doEvaltimeReplacement() {
    this.replacer(this.value, false);
  }

  doRuntimeReplacement() {
    this.replacer(this.value, false);
  }

  extractRules() {
    return {};
  }
}

module.exports = { default: ProcessorOptionsProcessor };
