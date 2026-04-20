import { join } from 'path';

import * as babel from '@babel/core';
import type { NodePath } from '@babel/core';
import type { CallExpression, Program } from '@babel/types';
import dedent from 'dedent';

import type { MissedBabelCoreTypes } from '../../types';
import {
  getReactImportSummary,
  isUnnecessaryReactCall,
} from '../../utils/isUnnecessaryReactCall';

const { File } = babel as typeof babel & MissedBabelCoreTypes;

const getExpression = (
  rawCode: TemplateStringsArray
): [NodePath<CallExpression>, NodePath<Program>] => {
  const code = dedent(rawCode);
  const filename = join(__dirname, 'source.ts');
  const ast = babel.parse(code, {
    babelrc: false,
    configFile: false,
    filename,
    presets: ['@babel/preset-typescript'],
    sourceType: 'module',
  })!;

  const file = new File({ filename }, { code, ast });
  const program = file.path.find((p) =>
    p.isProgram()
  ) as NodePath<Program> | null;
  const body = program?.get('body') ?? [];
  const lastStatement = body[body.length - 1];
  if (!lastStatement || !lastStatement.isExpressionStatement()) {
    throw new Error('Last statement is not an expression statement');
  }

  const expression = lastStatement.get('expression');
  if (!expression.isCallExpression()) {
    throw new Error('Last statement is not a call expression');
  }

  return [expression, program];
};

const check = (rawCode: TemplateStringsArray): boolean => {
  const [expression] = getExpression(rawCode);
  return isUnnecessaryReactCall(expression);
};

const checkWithSummary = (rawCode: TemplateStringsArray): boolean => {
  const [expression, program] = getExpression(rawCode);
  return isUnnecessaryReactCall(expression, getReactImportSummary(program));
};

describe('isUnnecessaryReactCall', () => {
  describe('jsx-runtime', () => {
    it('should process simple usage', () => {
      const result = check`
        import { jsx as jsx_runtime_1 } from "react/jsx-runtime";
        jsx_runtime_1("span", null, "Hello World");
      `;
      const summaryResult = checkWithSummary`
        import { jsx as jsx_runtime_1 } from "react/jsx-runtime";
        jsx_runtime_1("span", null, "Hello World");
      `;

      expect(result).toBe(true);
      expect(summaryResult).toBe(true);
    });

    it('should process usage wrapped with SequenceExpression', () => {
      const result = check`
        import { jsx as jsx_runtime_1 } from "react/jsx-runtime";
        (0, jsx_runtime_1)("span", null, "Hello World");
      `;

      expect(result).toBe(true);
    });

    it('should process namespaced', () => {
      const result = check`
        import * as jsx_runtime_1 from "react/jsx-runtime";
        (0, jsx_runtime_1.jsx)("div", null, "Hello World");
        (0, jsx_runtime_1.jsx)("span", null, "Hello World");
        (0, jsx_runtime_1.jsxs)("div", null, "Hello World");
        (0, jsx_runtime_1.jsxs)("span", null, "Hello World");
      `;

      expect(result).toBe(true);
    });
  });

  describe('classic react', () => {
    it('should process createElement', () => {
      const result = check`
        import { createElement } from "react";
        (0, createElement)("div", null, "Hello World");
      `;

      expect(result).toBe(true);
    });

    it('should process hooks', () => {
      const result = check`
        import { useState } from "react";
        (0, useState)(null);
      `;

      expect(result).toBe(true);
    });

    it('should ignore createContext', () => {
      const result = check`
        import { createContext } from "react";
        (0, createContext)();
      `;

      expect(result).toBe(false);
    });
  });
});
