/* eslint-env jest */
import type { Node } from 'oxc-parser';

import {
  collectOxcPatternBindingNames,
  collectOxcPatternRuntimeExpressions,
  getOxcBindingPatternFacts,
} from '../patterns';
import {
  appendOxcRuntimePropertyPath,
  createOxcRuntimePropertyPath,
  decomposeOxcMemberPath,
  getOxcRuntimePropertyPath,
  isOxcRuntimePropertyPathEqualOrDescendant,
  replaceOxcRuntimePropertyPathRoot,
} from '../projections';
import { parseOxcProgram } from '../parse';

const filename = '/source.ts';

const firstDeclarator = (
  code: string
): Extract<Node, { type: 'VariableDeclarator' }> => {
  const statement = parseOxcProgram(code, filename).body[0];
  expect(statement?.type).toBe('VariableDeclaration');
  if (statement?.type !== 'VariableDeclaration') {
    throw new Error('Expected a variable declaration');
  }

  const declarator = statement.declarations[0];
  if (!declarator) {
    throw new Error('Expected a variable declarator');
  }
  return declarator;
};

describe('shared OXC analysis primitives', () => {
  it('preserves duplicate bindings and runtime pattern evaluation order', () => {
    const code = `
      const {
        [(order = order * 10 + 1, 'outer')]: {
          [(order = order * 10 + 3, 'inner')]: width =
            (order = order * 10 + 4, order)
        } = (order = order * 10 + 2, {})
      } = {};
    `;
    const pattern = firstDeclarator(code).id;
    const facts = getOxcBindingPatternFacts(pattern);

    expect(collectOxcPatternBindingNames(pattern)).toEqual(['width']);
    expect(getOxcBindingPatternFacts(pattern)).toBe(facts);
    expect(facts.facts.map(({ kind, order }) => [kind, order])).toEqual([
      ['computed-key', 0],
      ['default', 1],
      ['computed-key', 2],
      ['default', 3],
      ['binding', 4],
    ]);
    expect(
      collectOxcPatternRuntimeExpressions(pattern).map((expression) =>
        code.slice(expression.start, expression.end)
      )
    ).toEqual([
      "(order = order * 10 + 1, 'outer')",
      '(order = order * 10 + 2, {})',
      "(order = order * 10 + 3, 'inner')",
      '(order = order * 10 + 4, order)',
    ]);

    const duplicatePattern = firstDeclarator(
      'const [width, width] = source;'
    ).id;
    expect(collectOxcPatternBindingNames(duplicatePattern)).toEqual([
      'width',
      'width',
    ]);

    const restPattern = firstDeclarator(
      'const { width, ...remaining } = source;'
    ).id;
    expect(
      getOxcBindingPatternFacts(restPattern).facts.map(({ kind }) => kind)
    ).toEqual(['binding', 'rest', 'binding']);
  });

  it('keeps literal dotted keys separate from nested paths', () => {
    const dotted = firstDeclarator('const value = box["a.b"];').init;
    const nested = firstDeclarator('const value = box.a.b;').init;
    if (!dotted || !nested) {
      throw new Error('Expected initializers');
    }

    const dottedProjection = decomposeOxcMemberPath(dotted);
    const nestedProjection = decomposeOxcMemberPath(nested);
    const dottedPath = getOxcRuntimePropertyPath(dotted);
    const nestedPath = getOxcRuntimePropertyPath(nested);

    expect(dottedProjection).toEqual({
      root: 'box',
      segments: [{ kind: 'literal', value: 'a.b' }],
    });
    expect(nestedProjection).toEqual({
      root: 'box',
      segments: [
        { kind: 'identifier', value: 'a' },
        { kind: 'identifier', value: 'b' },
      ],
    });
    expect(dottedPath?.key).not.toBe(nestedPath?.key);
  });

  it('supports root replacement and segment-aware descendant checks', () => {
    const root = createOxcRuntimePropertyPath('box');
    const child = appendOxcRuntimePropertyPath(root, 'a.b');
    const grandchild = appendOxcRuntimePropertyPath(child, 'leaf');
    const sibling = appendOxcRuntimePropertyPath(
      appendOxcRuntimePropertyPath(root, 'a'),
      'b'
    );

    expect(isOxcRuntimePropertyPathEqualOrDescendant(child, root)).toBe(true);
    expect(isOxcRuntimePropertyPathEqualOrDescendant(grandchild, child)).toBe(
      true
    );
    expect(isOxcRuntimePropertyPathEqualOrDescendant(sibling, child)).toBe(
      false
    );
    expect(replaceOxcRuntimePropertyPathRoot(child, 'alias')).toEqual({
      key: 'alias#3:a.b',
      root: 'alias',
      segments: ['a.b'],
    });
    expect(() => createOxcRuntimePropertyPath('box#1:a')).toThrow(
      'must not contain "#"'
    );
  });
});
