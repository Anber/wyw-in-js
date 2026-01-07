const nestingAtRules = new Set([
  'container',
  'document',
  'layer',
  'media',
  'scope',
  'starting-style',
  'supports',
]);

function isWhitespace(char: string) {
  return (
    char === ' ' ||
    char === '\n' ||
    char === '\r' ||
    char === '\t' ||
    char === '\f'
  );
}

function isKeyframesAtRule(name: string) {
  return name.toLowerCase().endsWith('keyframes');
}

function readString(css: string, start: number) {
  const quote = css[start];
  let idx = start + 1;

  while (idx < css.length) {
    const char = css[idx];

    if (char === '\\') {
      idx += 2;
    } else if (char === quote) {
      return idx + 1;
    } else {
      idx += 1;
    }
  }

  return css.length;
}

function readComment(css: string, start: number) {
  const end = css.indexOf('*/', start + 2);
  return end === -1 ? css.length : end + 2;
}

function findAtRuleTerminator(css: string, start: number) {
  let idx = start;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (idx < css.length) {
    const char = css[idx];

    if (char === '/' && css[idx + 1] === '*') {
      idx = readComment(css, idx);
    } else if (char === '"' || char === "'") {
      idx = readString(css, idx);
    } else {
      if (char === '(') parenDepth += 1;
      else if (char === ')' && parenDepth > 0) parenDepth -= 1;
      else if (char === '[') bracketDepth += 1;
      else if (char === ']' && bracketDepth > 0) bracketDepth -= 1;

      if (
        parenDepth === 0 &&
        bracketDepth === 0 &&
        (char === ';' || char === '{')
      ) {
        return idx;
      }

      idx += 1;
    }
  }

  return css.length;
}

function findMatchingBrace(css: string, openBraceIdx: number) {
  let idx = openBraceIdx + 1;
  let depth = 1;

  while (idx < css.length) {
    const char = css[idx];

    if (char === '/' && css[idx + 1] === '*') {
      idx = readComment(css, idx);
    } else if (char === '"' || char === "'") {
      idx = readString(css, idx);
    } else {
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return idx;
      }

      idx += 1;
    }
  }

  return -1;
}

function splitSelectorList(selectorText: string) {
  const parts: string[] = [];
  let start = 0;
  let idx = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (idx < selectorText.length) {
    const char = selectorText[idx];

    if (char === '/' && selectorText[idx + 1] === '*') {
      idx = readComment(selectorText, idx);
    } else if (char === '"' || char === "'") {
      idx = readString(selectorText, idx);
    } else {
      if (char === '(') parenDepth += 1;
      else if (char === ')' && parenDepth > 0) parenDepth -= 1;
      else if (char === '[') bracketDepth += 1;
      else if (char === ']' && bracketDepth > 0) bracketDepth -= 1;

      if (parenDepth === 0 && bracketDepth === 0 && char === ',') {
        parts.push(selectorText.slice(start, idx));
        start = idx + 1;
      }

      idx += 1;
    }
  }

  parts.push(selectorText.slice(start));

  return parts;
}

function wrapSelector(selectorText: string) {
  const selectors = splitSelectorList(selectorText)
    .map((s) => s.trim())
    .filter(Boolean);

  return selectors.map((selector) => `:global(${selector})`).join(', ');
}

function wrapKeyframesHeader(prelude: string) {
  let idx = 0;
  while (idx < prelude.length && isWhitespace(prelude[idx])) idx += 1;

  if (prelude.slice(idx).startsWith(':global(')) {
    return prelude;
  }

  const match = /^[A-Za-z_-][A-Za-z0-9_-]*/.exec(prelude.slice(idx));
  if (!match) return prelude;

  const name = match[0];
  const before = prelude.slice(0, idx);
  const after = prelude.slice(idx + name.length);
  return `${before}:global(${name})${after}`;
}

function makeCssModuleGlobalInner(css: string) {
  let idx = 0;
  let out = '';

  while (idx < css.length) {
    const char = css[idx];

    if (isWhitespace(char)) {
      out += char;
      idx += 1;
    } else if (char === '/' && css[idx + 1] === '*') {
      const end = readComment(css, idx);
      out += css.slice(idx, end);
      idx = end;
    } else if (char === '"' || char === "'") {
      const end = readString(css, idx);
      out += css.slice(idx, end);
      idx = end;
    } else if (char === '@') {
      const nameStart = idx + 1;
      let nameEnd = nameStart;
      while (nameEnd < css.length && /[A-Za-z0-9_-]/.test(css[nameEnd])) {
        nameEnd += 1;
      }
      const atRuleName = css.slice(nameStart, nameEnd);
      const terminatorIdx = findAtRuleTerminator(css, nameEnd);
      const terminator = css[terminatorIdx];
      const prelude = css.slice(nameEnd, terminatorIdx);

      if (terminator === ';') {
        out += css.slice(idx, terminatorIdx + 1);
        idx = terminatorIdx + 1;
      } else if (terminator !== '{') {
        out += css.slice(idx);
        break;
      } else {
        const blockEndIdx = findMatchingBrace(css, terminatorIdx);
        if (blockEndIdx === -1) {
          out += css.slice(idx);
          break;
        }

        const blockBody = css.slice(terminatorIdx + 1, blockEndIdx);

        if (isKeyframesAtRule(atRuleName)) {
          out += `@${atRuleName}${wrapKeyframesHeader(prelude)}{${blockBody}}`;
        } else if (nestingAtRules.has(atRuleName.toLowerCase())) {
          out += `@${atRuleName}${prelude}{${makeCssModuleGlobalInner(
            blockBody
          )}}`;
        } else {
          out += `@${atRuleName}${prelude}{${blockBody}}`;
        }

        idx = blockEndIdx + 1;
      }
    } else {
      // A selector rule: read until '{' at top-level.
      const openIdx = css.indexOf('{', idx);
      if (openIdx === -1) {
        out += css.slice(idx);
        break;
      }

      const selectorText = css.slice(idx, openIdx).trim();
      const blockEndIdx = findMatchingBrace(css, openIdx);
      if (blockEndIdx === -1) {
        out += css.slice(idx);
        break;
      }

      const blockBody = css.slice(openIdx + 1, blockEndIdx);
      out += `${wrapSelector(selectorText)}{${blockBody}}`;
      idx = blockEndIdx + 1;
    }
  }

  return out;
}

export function makeCssModuleGlobal(cssText: string) {
  return makeCssModuleGlobalInner(cssText);
}
