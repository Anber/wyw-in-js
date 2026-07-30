/* eslint-env jest */
import type { Node } from 'oxc-parser';

import {
  appendOxcAssignmentTargetLeaves,
  getOxcAssignmentTargetRootIdentifier,
  type OxcAssignmentTargetLeaf,
} from '../assignmentTargets';
import { getOxcNodeChildren, walkOxc } from '../ast';
import {
  visitOxcLexicalScopes,
  type OxcLexicalScopeBoundary,
} from '../lexicalScopes';
import {
  collectOxcPatternBindingNames,
  collectOxcPatternRuntimeExpressions,
  getOxcBindingPatternFacts,
} from '../patterns';
import {
  appendOxcRuntimePropertyPath,
  createOxcRuntimePropertyPath,
  decomposeOxcMemberPath,
  getOxcSyntacticPropertyKey,
  getOxcRuntimePropertyPath,
  isOxcRuntimePropertyPathEqualOrDescendant,
  replaceOxcRuntimePropertyPathRoot,
} from '../projections';
import { parseOxcProgram } from '../parse';

const filename = '/source.ts';

type TestScope = {
  kind: OxcLexicalScopeBoundary['kind'];
  parent: TestScope | null;
};

const collectRuntimeReferences = (
  code: string
): Array<{ name: string; scope: TestScope['kind'] }> => {
  const references: Array<{ name: string; scope: TestScope['kind'] }> = [];
  visitOxcLexicalScopes(
    parseOxcProgram(code, filename),
    null,
    (parent, boundary) => ({
      kind: boundary.kind,
      parent,
    }),
    (node, scope, _parent, _ancestors, _runtime, reference) => {
      if (reference && node.type === 'Identifier') {
        references.push({ name: node.name, scope: scope.kind });
      }
    }
  );
  return references;
};

const firstDeclarator = (
  code: string,
  sourceFilename = filename
): Extract<Node, { type: 'VariableDeclarator' }> => {
  const statement = parseOxcProgram(code, sourceFilename).body[0];
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
  it('discovers TS-only Identifier children after traversing a JS shape', () => {
    const jsIdentifier = firstDeclarator(
      'const value = source;',
      '/source.js'
    ).id;
    expect(jsIdentifier.type).toBe('Identifier');
    expect('decorators' in jsIdentifier).toBe(false);
    expect(getOxcNodeChildren(jsIdentifier)).toEqual([]);

    const program = parseOxcProgram(
      'class Live { method(@decorator value: TypeOnly) {} }',
      filename
    );
    const declaration = program.body[0];
    if (declaration?.type !== 'ClassDeclaration') {
      throw new Error('Expected a class declaration');
    }
    const method = declaration.body.body[0];
    if (method?.type !== 'MethodDefinition') {
      throw new Error('Expected a method definition');
    }
    const parameter = method.value.params[0];
    if (parameter?.type !== 'Identifier') {
      throw new Error('Expected an Identifier parameter');
    }
    expect('decorators' in parameter).toBe(true);

    expect(getOxcNodeChildren(parameter).map(({ type }) => type)).toEqual([
      'Decorator',
      'TSTypeAnnotation',
    ]);

    const visited: string[] = [];
    walkOxc(parameter, (node) => visited.push(node.type));
    expect(visited).toContain('Decorator');
  });

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

  it('collects assignment leaves in source order through transparent wrappers', () => {
    const code = `
      ([target, , target, { nested: ((box as Box).inner!).leaf, ...rest }] = source);
    `;
    const statement = parseOxcProgram(code, filename).body[0];
    if (statement?.type !== 'ExpressionStatement') {
      throw new Error('Expected an expression statement');
    }
    const expression =
      statement.expression.type === 'ParenthesizedExpression'
        ? statement.expression.expression
        : statement.expression;
    if (expression?.type !== 'AssignmentExpression') {
      throw new Error('Expected an assignment expression');
    }

    const leaves: OxcAssignmentTargetLeaf[] = [];
    appendOxcAssignmentTargetLeaves(expression.left, leaves);

    expect(leaves.map((leaf) => leaf.type)).toEqual([
      'Identifier',
      'Identifier',
      'MemberExpression',
      'Identifier',
    ]);
    expect(leaves.map((leaf) => code.slice(leaf.start, leaf.end))).toEqual([
      'target',
      'target',
      '((box as Box).inner!).leaf',
      'rest',
    ]);
    expect(getOxcAssignmentTargetRootIdentifier(leaves[2]!)).toMatchObject({
      name: 'box',
      type: 'Identifier',
    });

    const unsupported = firstDeclarator('const value = this;').init;
    if (!unsupported) {
      throw new Error('Expected an initializer');
    }
    appendOxcAssignmentTargetLeaves(unsupported, leaves);
    expect(leaves).toHaveLength(4);
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

  it('recognizes only scalar syntactic property keys', () => {
    const property = (code: string): { computed: boolean; key: Node } => {
      const expression = firstDeclarator(`const value = ${code};`).init;
      if (!expression || expression.type !== 'MemberExpression') {
        throw new Error('Expected a member expression');
      }
      return { computed: expression.computed, key: expression.property };
    };

    const plain = property('source.width');
    const string = property('source["width"]');
    const number = property('source[4]');
    const dynamic = property('source[key]');
    const boolean = property('source[true]');
    const nil = property('source[null]');
    const bigint = property('source[1n]');

    expect(getOxcSyntacticPropertyKey(plain.key, plain.computed)).toBe('width');
    expect(getOxcSyntacticPropertyKey(string.key, string.computed)).toBe(
      'width'
    );
    expect(getOxcSyntacticPropertyKey(string.key, false)).toBe('width');
    expect(getOxcSyntacticPropertyKey(number.key, number.computed)).toBe(4);
    expect(
      getOxcSyntacticPropertyKey(dynamic.key, dynamic.computed)
    ).toBeNull();
    expect(
      getOxcSyntacticPropertyKey(boolean.key, boolean.computed)
    ).toBeNull();
    expect(getOxcSyntacticPropertyKey(nil.key, nil.computed)).toBeNull();
    expect(getOxcSyntacticPropertyKey(bigint.key, bigint.computed)).toBeNull();
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

  it('separates parameter defaults from the function body scope', () => {
    const references = collectRuntimeReferences(`
      const outer = 1;
      function run(value = outer) {
        var outer = 2;
        return value + outer;
      }
    `);

    expect(references).toEqual([
      { name: 'outer', scope: 'function-parameters' },
      { name: 'value', scope: 'function-body' },
      { name: 'outer', scope: 'function-body' },
    ]);
  });

  it('routes parameter and named class decorators through enclosing scope', () => {
    const references = collectRuntimeReferences(`
      class Live {
        constructor(@parameterDecorator public value: TypeOnly = source) {}
      }
      const Named = @classDecorator class classDecorator {};
    `);

    expect(references).toEqual([
      { name: 'parameterDecorator', scope: 'program' },
      { name: 'source', scope: 'function-parameters' },
      { name: 'classDecorator', scope: 'program' },
    ]);
  });

  it('visits a switch discriminant before entering the case scope', () => {
    const references = collectRuntimeReferences(`
      switch (source) {
        case key:
          let source = value;
          source;
      }
    `);

    expect(references).toEqual([
      { name: 'source', scope: 'program' },
      { name: 'key', scope: 'switch' },
      { name: 'value', scope: 'switch' },
      { name: 'source', scope: 'switch' },
    ]);
  });
});
