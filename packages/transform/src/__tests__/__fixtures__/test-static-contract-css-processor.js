const { TaggedTemplateProcessor } = require('@wyw-in-js/processor-utils');

class StaticContractCssProcessor extends TaggedTemplateProcessor {
  get asSelector() {
    return this.className;
  }

  get value() {
    return this.astService.stringLiteral(`legacy-${this.className}`);
  }

  getStaticValue() {
    return {
      className: this.className,
      kind: 'class-name',
      value: `contract-${this.className}`,
    };
  }

  addInterpolation(_node, _precedingCss, source) {
    throw new Error(
      `css tag cannot handle '${source}' as an interpolated value`
    );
  }

  doEvaltimeReplacement() {
    this.replacer(this.value, false);
  }

  doRuntimeReplacement() {
    this.replacer(this.value, false);
  }

  extractRules(_valueCache, cssText, loc) {
    const selector = `.${this.className}`;

    return {
      [selector]: {
        cssText,
        className: this.className,
        displayName: this.displayName,
        start: loc?.start ?? null,
      },
    };
  }
}

module.exports = { default: StaticContractCssProcessor };
