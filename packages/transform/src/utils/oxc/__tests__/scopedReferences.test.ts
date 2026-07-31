/* eslint-env jest */

import { parseOxcProgram } from '../parse';
import {
  visitOxcScopedReferences,
  type OxcScopedBindingPolicy,
  type OxcScopedRootPolicy,
} from '../scopedReferences';

const filename = '/source.ts';

const collectReferences = (
  code: string,
  bindingPolicy: OxcScopedBindingPolicy,
  rootPolicy: OxcScopedRootPolicy = 'local'
): string[] => {
  const references: string[] = [];
  visitOxcScopedReferences(
    parseOxcProgram(code, filename),
    bindingPolicy,
    rootPolicy,
    (name) => references.push(name)
  );
  return references;
};

describe('shared OXC scoped references', () => {
  it('keeps declaration bindings visible only to the full policy', () => {
    const code = `
      function outer() {
        before();
        local;
        function before() {}
        var local = source;
        return after;
      }
    `;

    expect(collectReferences(code, 'minimal')).toEqual([
      'before',
      'local',
      'source',
      'after',
    ]);
    expect(collectReferences(code, 'full')).toEqual(['source', 'after']);
  });

  it('shares parameter, catch, and named-expression bindings', () => {
    const code = `
      const fn = function self(param = defaultValue) {
        try {
          return self(param, external);
        } catch (error) {
          return error + caughtExternal;
        }
      };
      const Type = class Named {
        method() { return Named + classExternal; }
      };
    `;
    const expected = [
      'defaultValue',
      'external',
      'caughtExternal',
      'classExternal',
    ];

    expect(collectReferences(code, 'minimal')).toEqual(expected);
    expect(collectReferences(code, 'full')).toEqual(expected);
  });

  it('exposes standalone root bindings only through the external policy', () => {
    const program = parseOxcProgram(
      'function root() { return root() + outside; }',
      filename
    );
    const declaration = program.body[0];
    if (declaration?.type !== 'FunctionDeclaration') {
      throw new Error('Expected a function declaration');
    }
    const collect = (rootPolicy: OxcScopedRootPolicy): string[] => {
      const references: string[] = [];
      visitOxcScopedReferences(declaration, 'full', rootPolicy, (name) =>
        references.push(name)
      );
      return references;
    };

    expect(collect('local')).toEqual(['outside']);
    expect(collect('external')).toEqual(['root', 'outside']);
  });

  it('keeps a switch discriminant outside the shared case scope', () => {
    expect(
      collectReferences(
        `
          switch (value) {
            case key:
              let value = local;
              value;
          }
        `,
        'full'
      )
    ).toEqual(['value', 'key', 'local']);
  });

  it('registers runtime TypeScript enums and imports only in full mode', () => {
    const code = `
      import { dep } from './dep';
      enum Kind { A = seed }
      dep;
      Kind.A;
      outside;
    `;

    expect(collectReferences(code, 'minimal')).toEqual([
      'dep',
      'Kind',
      'outside',
    ]);
    expect(collectReferences(code, 'full')).toEqual(['outside']);
  });
});
