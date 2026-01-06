const { TaggedTemplateProcessor } = require('@wyw-in-js/processor-utils');

class PureAnnotationArrowProcessor extends TaggedTemplateProcessor {
  get asSelector() {
    return this.className;
  }

  get value() {
    return this.astService.stringLiteral(this.className);
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
    const arrowFn = this.astService.arrowFunctionExpression(
      [],
      this.astService.identifier('x')
    );
    this.replacer(arrowFn, true);
  }

  extractRules(_valueCache, _cssText, _loc) {
    return {};
  }
}

module.exports = { default: PureAnnotationArrowProcessor };
