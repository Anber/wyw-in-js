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
