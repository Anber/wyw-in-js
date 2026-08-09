export type OxcValueReplacement = {
  end: number;
  start: number;
  value: string;
};

export type OxcTextReplacement = {
  end: number;
  start: number;
  text: string;
};

export type OxcReplacement = OxcTextReplacement | OxcValueReplacement;

const getReplacementValue = (replacement: OxcReplacement): string => {
  if ('value' in replacement) {
    return replacement.value;
  }

  return replacement.text;
};

const containsReplacement = (
  outer: OxcReplacement,
  inner: OxcReplacement
): boolean => outer.start <= inner.start && outer.end >= inner.end;

/**
 * Applies replacement layers that all refer to the same source text.
 *
 * Earlier layers win when two replacements cover the same range. Otherwise,
 * an outer replacement makes nested replacements irrelevant. Zero-width
 * insertions at an outer replacement boundary survive, which lets dependency
 * helpers be emitted immediately before code removed from the evaltime view.
 */
export const applyOxcReplacementLayers = (
  code: string,
  layers: readonly (readonly OxcReplacement[])[]
): string => {
  const replacements: OxcReplacement[] = [];

  layers.forEach((layer) => {
    layer.forEach((replacement) => {
      const isInsertion = replacement.start === replacement.end;
      const overlapsPartially = replacements.some(
        (current) =>
          current.start !== current.end &&
          replacement.start !== replacement.end &&
          current.start < replacement.end &&
          replacement.start < current.end &&
          !containsReplacement(current, replacement) &&
          !containsReplacement(replacement, current)
      );
      if (overlapsPartially) {
        throw new Error('Oxc replacement layers overlap without containment');
      }

      const covering = replacements.find(
        (current) =>
          current.start !== current.end &&
          containsReplacement(current, replacement)
      );

      if (
        covering &&
        (!isInsertion ||
          (replacement.start > covering.start &&
            replacement.start < covering.end))
      ) {
        return;
      }

      if (!isInsertion) {
        for (let idx = replacements.length - 1; idx >= 0; idx -= 1) {
          const current = replacements[idx]!;
          const currentIsInsertion = current.start === current.end;
          if (
            containsReplacement(replacement, current) &&
            (!currentIsInsertion ||
              (current.start > replacement.start &&
                current.start < replacement.end))
          ) {
            replacements.splice(idx, 1);
          }
        }
      }

      replacements.push(replacement);
    });
  });

  let result = code;
  replacements
    .sort((a, b) => {
      if (a.start !== b.start) {
        return b.start - a.start;
      }

      // Apply a consuming replacement first so a boundary insertion is not
      // swallowed by its source range.
      return b.end - a.end;
    })
    .forEach((replacement) => {
      result =
        result.slice(0, replacement.start) +
        getReplacementValue(replacement) +
        result.slice(replacement.end);
    });

  return result;
};

export const applyOxcReplacements = (
  code: string,
  replacements: OxcReplacement[]
): string => {
  let result = code;
  [...replacements]
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      result =
        result.slice(0, replacement.start) +
        getReplacementValue(replacement) +
        result.slice(replacement.end);
    });

  return result;
};
