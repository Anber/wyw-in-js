import type { SourceLocation } from '@wyw-in-js/processor-utils';
import type { Program } from 'oxc-parser';

import { printOxcAstServiceImport, type AddedImport } from '../oxcAstService';
import { parseOxcProgram } from '../oxc/parse';
import {
  createOxcSourceLocation,
  type OxcLocationLookup,
} from '../oxc/sourceLocations';

export const GENERATED_HELPER_NAME_RE = /^_exp\d*$/;
export const WYW_META_EXTENDS_HELPER_RE =
  /(?:\bextends|["']extends["'])\s*:\s*(_exp\d*)\s*\(\s*\)/g;
export const JS_IDENTIFIER_RE = /[$A-Z_a-z][$\w]*/g;

export const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgram(code, filename, 'module');
};

export const insertAddedImports = (
  code: string,
  program: Program,
  addedImports: AddedImport[]
): string => {
  if (addedImports.length === 0) {
    return code;
  }

  const uniqueImports = [
    ...new Map(
      addedImports.map((item) => [
        `${item.source}\0${item.imported}\0${item.local}`,
        item,
      ])
    ).values(),
  ];
  const importBlock = uniqueImports.map(printOxcAstServiceImport).join('\n');
  const lastImport = [...program.body]
    .reverse()
    .find((statement) => statement.type === 'ImportDeclaration');
  const hashbangEnd = code.startsWith('#!')
    ? (() => {
        const newline = code.indexOf('\n');
        return newline === -1 ? code.length : newline + 1;
      })()
    : 0;
  const insertionPoint = lastImport?.end ?? hashbangEnd;
  const prefix = code.slice(0, insertionPoint);
  const suffix = code.slice(insertionPoint);
  const leadingBreak = prefix.length > 0 && !prefix.endsWith('\n') ? '\n' : '';
  const trailingBreak =
    suffix.length > 0 && !suffix.startsWith('\n') ? '\n' : '';

  return `${prefix}${leadingBreak}${importBlock}${trailingBreak}${suffix}`;
};

export const getSourceLocation = (
  start: number,
  end: number,
  loc: OxcLocationLookup,
  filename?: string | null
): SourceLocation => createOxcSourceLocation(start, end, loc, filename);
