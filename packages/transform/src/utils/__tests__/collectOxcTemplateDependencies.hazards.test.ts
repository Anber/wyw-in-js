/* eslint-env jest */
import dedent from 'dedent';

import {
  collectOxcExpressionDependencies,
  collectOxcTemplateDependencies,
} from '../collectOxcTemplateDependencies';
import {
  analyzeProgram,
  findReferences,
  getRootMutationHazards,
  parseOxc,
  resolveBindingAt,
  toMutationBindingKey,
} from '../collectOxcTemplateDependencies/scopeAnalysis';

const filename = '/source.tsx';
const transparentTypeScriptExpressions = [
  ['TSAsExpression', 'source as { width: number }'],
  ['TSSatisfiesExpression', 'source satisfies { width: number }'],
  ['TSNonNullExpression', 'source!'],
] as const;

const expectWidthFallback = (code: string): void => {
  const result = collectOxcTemplateDependencies(code, filename, true);

  expect(result.staticValues).toEqual([]);
  expect(result.staticValueCandidates).toEqual([]);
  expect(result.dependencyNames).toEqual(['width']);
};

const expectLastWidthTemplateFallback = (code: string): void => {
  const tagStart = code.lastIndexOf('tag`');
  const templateStart = tagStart + 'tag'.length;
  const templateEnd = code.indexOf('`;', templateStart) + 1;
  const result = collectOxcTemplateDependencies(code, filename, true, [
    {
      end: templateEnd,
      start: templateStart,
    },
  ]);

  expect(result.staticValues).toEqual([]);
  expect(result.staticValueCandidates).toEqual([]);
  expect(result.dependencyNames).toEqual(['width']);
};

describe('collectOxcTemplateDependencies mutation provenance', () => {
  it.each(transparentTypeScriptExpressions)(
    'keeps the runtime reference inside a transparent %s',
    (_description, expression) => {
      const program = parseOxc(`const alias = ${expression};`, filename);
      const statement = program.body[0];

      expect(statement?.type).toBe('VariableDeclaration');
      if (statement?.type !== 'VariableDeclaration') {
        throw new Error('Expected a variable declaration');
      }

      const initializer = statement.declarations[0]?.init;
      expect(initializer).toBeDefined();
      expect(
        findReferences(initializer!).map((reference) => reference.name)
      ).toEqual(['source']);
    }
  );

  it.each(transparentTypeScriptExpressions)(
    'propagates an alias mutation through a transparent %s',
    (_description, expression) => {
      expectWidthFallback(dedent`
        const source = { width: 304 };
        const alias = ${expression};
        alias.width = 400;
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `);
    }
  );

  it.each([
    [
      'Object.prototype',
      'Object.prototype.width = 400;',
      'const { width = 304 } = source;',
    ],
    [
      'Array.prototype iteration',
      'Array.prototype[Symbol.iterator] = function* iterator() { yield 400; };',
      'const [width] = source;',
    ],
  ])(
    'does not detach an imported projection from an earlier %s mutation',
    (_description, mutation, declaration) => {
      expectWidthFallback(dedent`
        import { source } from './tokens';

        ${mutation}
        ${declaration}
        const template = tag\`${'${width}'}\`;
      `);
    }
  );

  it.each([
    [
      'a class static field',
      dedent`
        const source = { width: 304 };
        class Holder {
          static value = source;
        }
        Holder.value.width = 400;
      `,
    ],
    [
      'an invoked parameter default',
      dedent`
        const source = { width: 304 };
        ((value = source) => {
          value.width = 400;
        })();
      `,
    ],
    [
      'a for-of binding default',
      dedent`
        const source = { width: 304 };
        for (const { value = source } of [{}]) {
          value.width = 400;
        }
      `,
    ],
  ])('tracks source aliases through %s', (_description, setup) => {
    expectWidthFallback(dedent`
      ${setup}
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it('tracks a source alias through a function-local class static field', () => {
    const code = dedent`
      function run() {
        const source = { width: 304 };
        class Holder {
          static value = source;
        }
        Holder.value.width = 400;
        const { width } = source;
        return tag\`${'${width}'}\`;
      }
      run();
    `;
    const analysis = analyzeProgram(parseOxc(code, filename));
    const sourceReference = code.lastIndexOf('source;');
    const sourceBinding = resolveBindingAt(
      {
        bindingResolutionCache: new Map(),
        bindingsByName: analysis.bindingsByName,
      },
      'source',
      sourceReference
    );

    expect(sourceBinding).toBeDefined();
    const hazards = getRootMutationHazards(
      analysis.rootMutationHazardsByBinding,
      toMutationBindingKey(sourceBinding!)
    );
    expect(
      hazards.map((hazard) => code.slice(hazard.start, hazard.end))
    ).toContain('Holder.value.width = 400');
  });

  it.each([
    [
      'a for-of binding',
      dedent`
        const source = { width: 304 };
        for (const alias of [source]) {
          alias.width = 400;
        }
      `,
    ],
    [
      'a catch binding',
      dedent`
        const source = { width: 304 };
        try {
          throw source;
        } catch (alias) {
          alias.width = 400;
        }
      `,
    ],
    [
      'a local call argument',
      dedent`
        const source = { width: 304 };
        const alias = source;
        function mutate(value) {
          value.width = 400;
        }
        mutate(alias);
      `,
    ],
    [
      'a local constructor argument',
      dedent`
        const source = { width: 304 };
        const alias = source;
        class Mutator {
          constructor(value) {
            value.width = 400;
          }
        }
        new Mutator(alias);
      `,
    ],
  ])('tracks source escape through %s', (_description, setup) => {
    expectWidthFallback(dedent`
      ${setup}
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it('tracks source escape through a local tagged-template interpolation', () => {
    const code = dedent`
      const source = { width: 304 };
      const alias = source;
      function mutate(_strings, value) {
        value.width = 400;
      }
      mutate\`${'${alias}'}\`;
      const { width } = source;
      width;
    `;
    const expressionStart = code.lastIndexOf('width');
    const result = collectOxcExpressionDependencies(code, filename, true, [
      {
        end: expressionStart + 'width'.length,
        start: expressionStart,
      },
    ]);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it.each([
    ['a parenthesized member call', '(source.mutate)();'],
    ['an aliased function call', 'const fn = mutate; fn();'],
    ['a direct constructor', 'new Mutator();'],
    ['a member constructor', 'new source.Mutator();'],
    ['a direct tagged template', 'mutate`x`;'],
    ['a member tagged template', 'source`x`;'],
    ['a sequence callee', '(0, mutate)();'],
    ['a conditional callee', '(true ? mutate : () => {})();'],
    ['an optional callee', 'mutate?.();'],
  ])('tracks opaque imported provenance through %s', (_description, invoke) => {
    expectWidthFallback(dedent`
      import { Mutator, mutate, source } from './tokens';

      ${invoke}
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it('does not confuse a shadowing parameter with an imported binding', () => {
    const result = collectOxcTemplateDependencies(
      dedent`
        import { mutate, source } from './tokens';

        function unused(mutate) {
          mutate();
        }

        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toHaveLength(1);
    expect(result.staticValueCandidates[0]?.source).toContain('=> width');
  });

  it('does not let an unrelated Object shadow hide a global intrinsic mutation', () => {
    expectWidthFallback(dedent`
      import { source } from './tokens';

      Object.prototype.width = 400;
      function unused(Object) {
        return Object;
      }

      const { width = 304 } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it('does not read a later var redeclaration initializer before it executes', () => {
    const result = collectOxcTemplateDependencies(
      dedent`
        var source = { width: 304 };
        const { width } = source;
        var source = { width: 400 };
        const template = tag\`${'${width}'}\`;
      `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([
      expect.objectContaining({
        value: 304,
      }),
    ]);
  });

  it.each([
    ['an if branch', 'if (false) { var x = 2; }'],
    ['a while body', 'while (false) { var x = 2; }'],
    ['a for body', 'for (; false; ) { var x = 2; }'],
    ['a switch case', 'switch (0) { case 1: var x = 2; }'],
  ])(
    'does not treat a var initializer in %s as dominating',
    (_description, declaration) => {
      const result = collectOxcTemplateDependencies(
        dedent`
          ${declaration}
          const template = tag\`${'${x}'}\`;
        `,
        filename,
        true
      );

      expect(result.staticValues).toEqual([]);
      expect(result.staticValueCandidates).toEqual([]);
      expect(result.dependencyNames).toEqual(['x']);
    }
  );

  it('registers a class declaration as a lexical shadow before its declaration', () => {
    const result = collectOxcTemplateDependencies(
      dedent`
        import { source } from './tokens';

        function unused() {
          source.width = 400;
          class source {}
        }

        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toHaveLength(1);
    expect(result.staticValueCandidates[0]?.source).toContain('=> width');
  });

  it.each([
    [
      'a named function expression',
      dedent`
        const unused = function source() {
          source.width = 400;
        };
      `,
    ],
    [
      'a named class expression',
      dedent`
        const unused = class source {
          static mutate() {
            source.width = 400;
          }
        };
      `,
    ],
  ])('keeps %s name scoped to its own body', (_description, declaration) => {
    const result = collectOxcTemplateDependencies(
      dedent`
        import { source } from './tokens';

        ${declaration}
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toHaveLength(1);
    expect(result.staticValueCandidates[0]?.source).toContain('=> width');
  });

  it.each([
    [
      'for statement',
      dedent`
        import { source } from './tokens';
        void source /* before */;
        for (let source = initial; source; source = next) {
          consume(source /* inside */);
        }
        void source /* after */;
      `,
    ],
    [
      'switch statement',
      dedent`
        import { source } from './tokens';
        switch (source /* before */) {
          case 0:
            let source;
            consume(source /* inside */);
        }
        void source /* after */;
      `,
    ],
  ])('limits a lexical binding to its %s', (_description, code) => {
    const analysis = analyzeProgram(parseOxc(code, filename));
    const resolutionContext = {
      bindingResolutionCache: new Map(),
      bindingsByName: analysis.bindingsByName,
    };
    const resolveMarker = (marker: string) =>
      resolveBindingAt(
        resolutionContext,
        'source',
        code.indexOf(`source /* ${marker} */`)
      );

    expect(resolveMarker('before')?.importedFrom).toBe('./tokens');
    expect(resolveMarker('inside')?.declarationKind).toBe('let');
    expect(resolveMarker('inside')?.importedFrom).toBeUndefined();
    expect(resolveMarker('after')?.importedFrom).toBe('./tokens');
  });

  it.each([
    [
      'a for-of identifier',
      dedent`
        const source = 304;
        void source /* before */;
        for (const source of tag\`${'${source /* rhs */}'}\`) {
          void source /* inside */;
        }
        void source /* after */;
      `,
    ],
    [
      'a for-in identifier',
      dedent`
        const source = 304;
        void source /* before */;
        for (const source in tag\`${'${source /* rhs */}'}\`) {
          void source /* inside */;
        }
        void source /* after */;
      `,
    ],
    [
      'a for-of destructuring pattern',
      dedent`
        const source = 304;
        void source /* before */;
        for (const { value: source } of tag\`${'${source /* rhs */}'}\`) {
          void source /* inside */;
        }
        void source /* after */;
      `,
    ],
  ])('keeps %s binding in the RHS temporal dead zone', (_description, code) => {
    const analysis = analyzeProgram(parseOxc(code, filename));
    const resolutionContext = {
      bindingResolutionCache: new Map(),
      bindingsByName: analysis.bindingsByName,
    };
    const resolveMarker = (marker: string) =>
      resolveBindingAt(
        resolutionContext,
        'source',
        code.indexOf(`source /* ${marker} */`)
      );
    const rhs = resolveMarker('rhs');

    expect(resolveMarker('before')).not.toBe(rhs);
    expect(resolveMarker('inside')).toBe(rhs);
    expect(resolveMarker('after')).not.toBe(rhs);
    expect(rhs).toMatchObject({
      declarationKind: 'const',
      isIteration: true,
      isRoot: false,
    });
    expect(() =>
      collectOxcTemplateDependencies(code, filename, true)
    ).toThrow();
  });

  it('does not create a lexical RHS shadow for an assignment-form loop', () => {
    const code = dedent`
      let source = [304];
      void source /* before */;
      for (source of tag\`${'${source /* rhs */}'}\`) {
        void source /* inside */;
      }
      void source /* after */;
    `;
    const analysis = analyzeProgram(parseOxc(code, filename));
    const resolutionContext = {
      bindingResolutionCache: new Map(),
      bindingsByName: analysis.bindingsByName,
    };
    const resolveMarker = (marker: string) =>
      resolveBindingAt(
        resolutionContext,
        'source',
        code.indexOf(`source /* ${marker} */`)
      );
    const outer = resolveMarker('before');

    expect(resolveMarker('rhs')).toBe(outer);
    expect(resolveMarker('inside')).toBe(outer);
    expect(resolveMarker('after')).toBe(outer);
    expect(outer?.isIteration).not.toBe(true);
  });

  it.each([
    ['a lexical declaration', 'const width = 20;'],
    ['a var declaration', 'var width = 20;'],
    ['a destructuring declaration', 'const { width } = { width: 20 };'],
  ])('keeps %s scoped to a class static block', (_description, declaration) => {
    const code = dedent`
        const width = 10;
        class Holder {
          static {
            void width /* before */;
            ${declaration}
            void width /* inside */;
          }
        }
        void width /* outer */;
      `;
    const analysis = analyzeProgram(parseOxc(code, filename));
    const resolutionContext = {
      bindingResolutionCache: new Map(),
      bindingsByName: analysis.bindingsByName,
    };
    const resolveMarker = (marker: string) =>
      resolveBindingAt(
        resolutionContext,
        'width',
        code.indexOf(`width /* ${marker} */`)
      );
    const before = resolveMarker('before');
    const inside = resolveMarker('inside');
    const outer = resolveMarker('outer');

    expect(before).toBe(inside);
    expect(inside?.scope).toMatchObject({
      functionBoundary: true,
      root: false,
    });
    expect(outer).not.toBe(inside);
    expect(outer?.scope.root).toBe(true);
  });

  it.each([
    ['a lexical declaration', 'const width = 20;'],
    ['a var declaration', 'var width = 20;'],
    ['a destructuring declaration', 'const { width } = { width: 20 };'],
  ])(
    'evaluates %s independently from its outer static-block shadow',
    (_description, declaration) => {
      const result = collectOxcTemplateDependencies(
        dedent`
          const width = 10;
          class Holder {
            static {
              ${declaration}
              tag\`${'${width}'}\`;
            }
          }
          tag\`${'${width}'}\`;
        `,
        filename,
        true
      );

      expect(result.staticValues.map(({ value }) => value)).toEqual([20, 10]);
    }
  );

  it('tracks a source default through an assignment-form for-of pattern', () => {
    expectWidthFallback(dedent`
      const source = { width: 304 };
      let alias;
      for ({ value: alias = source } of [{}]) {
        alias.width = 400;
      }
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it('tracks a source default through a catch binding pattern', () => {
    expectWidthFallback(dedent`
      const source = { width: 304 };
      try {
        throw {};
      } catch ({ value: alias = source }) {
        alias.width = 400;
      }
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it('treats a dynamic import result as unproven alias provenance', () => {
    expectWidthFallback(dedent`
      import { source } from './tokens';

      const namespace = await import('./tokens');
      namespace.source.width = 400;
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it('treats an unresolved member read as unproven alias provenance', () => {
    expectWidthFallback(dedent`
      import { source } from './tokens';

      const alias = registry.source;
      alias.width = 400;
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it.each([
    ['a bare unresolved identifier', 'const alias = current;'],
    ['an identifier-free member root', 'const alias = ({}).current;'],
    ['a this member root', 'const alias = this.current;'],
    [
      'a super member root',
      dedent`
        class Holder extends Base {
          mutate() {
            const alias = super.current;
            alias.width = 400;
          }
        }
      `,
    ],
  ])('treats %s as unproven alias provenance', (_description, declaration) => {
    const mutation = declaration.includes('class Holder')
      ? ''
      : 'alias.width = 400;';
    expectWidthFallback(dedent`
        import { source } from './tokens';

        ${declaration}
        ${mutation}
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `);
  });

  it.each(['holder.alias', 'holder[0]'])(
    'tracks assignment-form for-of member target %s',
    (target) => {
      expectWidthFallback(dedent`
        import { source } from './tokens';

        const holder = {};
        for (${target} of [source]) {
          ${target}.width = 400;
        }
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `);
    }
  );

  it('treats an implicitly-thrown catch value as unproven provenance', () => {
    expectWidthFallback(dedent`
      import { source } from './tokens';

      const throwing = {
        get current() {
          throw source;
        },
      };
      try {
        throwing.current;
      } catch (alias) {
        alias.width = 400;
      }
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });

  it.each([
    ['an opaque call argument', 'mutate(alias);'],
    ['an opaque constructor argument', 'new Mutator(alias);'],
    ['a resolved local tag interpolation', 'localTag`${alias}`;'],
    ['an unresolved tag interpolation', 'globalTag`${alias}`;'],
  ])(
    'propagates a sibling-import escape through %s',
    (_description, escape) => {
      expectLastWidthTemplateFallback(dedent`
        import { Mutator, alias, source } from './tokens';

        function localTag() {}
        ${escape}
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `);
    }
  );

  it('ignores interpolation provenance inside a processor-managed tag', () => {
    const code = dedent`
      import { alias, source } from './tokens';

      processor\`${'${alias}'}\`;
      const { width } = source;
      width;
    `;
    const processorStart = code.indexOf('processor`');
    const processorEnd = code.indexOf('`;', processorStart) + 1;
    const expressionStart = code.lastIndexOf('width');
    const result = collectOxcExpressionDependencies(
      code,
      filename,
      true,
      [
        {
          end: expressionStart + 'width'.length,
          start: expressionStart,
        },
      ],
      undefined,
      [
        {
          end: processorEnd,
          start: processorStart,
        },
      ]
    );

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toHaveLength(1);
    expect(result.staticValueCandidates[0]?.source).toContain('=> width');
  });

  it('preserves a nested call hazard seed inside a processor-managed interpolation', () => {
    const code = dedent`
      import { mutate, source } from './tokens';

      processor\`${'${mutate(source)}'}\`;
      const { width } = source;
      processor\`${'${width}'}\`;
    `;
    const firstProcessorStart = code.indexOf('processor`');
    const firstProcessorEnd = code.indexOf('`;', firstProcessorStart) + 1;
    const secondProcessorStart = code.lastIndexOf('processor`');
    const secondProcessorEnd = code.indexOf('`;', secondProcessorStart) + 1;
    const expressionStart = code.lastIndexOf('width');
    const result = collectOxcExpressionDependencies(
      code,
      filename,
      true,
      [
        {
          end: expressionStart + 'width'.length,
          start: expressionStart,
        },
      ],
      undefined,
      [
        {
          end: firstProcessorEnd,
          start: firstProcessorStart,
        },
        {
          end: secondProcessorEnd,
          start: secondProcessorStart,
        },
      ]
    );

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it.each([
    [
      'a local alias write',
      dedent`
        const source = { width: 608 };
        const alias = source;
        alias.width = 704;
        const template = tag\`${'${source.width}'}\`;
      `,
    ],
    [
      'a nested alias write',
      dedent`
        const source = { nested: { width: 608 } };
        const alias = source.nested;
        alias.width = 704;
        const template = tag\`${'${source.nested.width}'}\`;
      `,
    ],
    [
      'a local mutator call',
      dedent`
        const source = { width: 608 };
        function mutate(value) {
          value.width = 704;
        }
        mutate(source);
        const template = tag\`${'${source.width}'}\`;
      `,
    ],
    [
      'Object.assign',
      dedent`
        const source = { width: 608 };
        Object.assign(source, { width: 704 });
        const template = tag\`${'${source.width}'}\`;
      `,
    ],
  ])(
    'does not create a stale root-object candidate after %s',
    (_description, code) => {
      const result = collectOxcTemplateDependencies(code, filename, true);

      expect(result.staticValues).toEqual([]);
      expect(result.staticValueCandidates).toEqual([]);
      expect(result.code).not.toContain('const _exp = () => (608);');
      expect(result.dependencyNames).toEqual(['source']);
    }
  );

  it('keeps replaying a modeled direct root-object assignment', () => {
    const result = collectOxcTemplateDependencies(
      dedent`
        const source = { width: 608 };
        source.width = 704;
        const template = tag\`${'${source.width}'}\`;
      `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([{ name: '_exp', value: 704 }]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.code).toContain('const _exp = () => (704);');
  });

  it.each([
    [
      'an object-rest nested assignment',
      dedent`
        const source = { nested: { width: 304 }, omitted: true };
        const { omitted, ...rest } = source;
        rest.nested.width = 400;
        const { nested: { width } } = source;
        const template = tag\`${'${width}'}\`;
      `,
    ],
    [
      'an object-rest nested delete',
      dedent`
        const source = { nested: { width: 304 }, omitted: true };
        const { omitted, ...rest } = source;
        delete rest.nested.width;
        const { nested: { width = 400 } } = source;
        const template = tag\`${'${width}'}\`;
      `,
    ],
    [
      'an array-rest nested assignment',
      dedent`
        const source = [{ width: 304 }];
        const [...rest] = source;
        rest[0].width = 400;
        const [{ width }] = source;
        const template = tag\`${'${width}'}\`;
      `,
    ],
    [
      'an array-rest nested delete',
      dedent`
        const source = [{ width: 304 }];
        const [...rest] = source;
        delete rest[0].width;
        const [{ width = 400 }] = source;
        const template = tag\`${'${width}'}\`;
      `,
    ],
  ])('propagates source provenance through %s', (_description, code) => {
    expectWidthFallback(code);
  });

  it.each([
    [
      'object rest',
      dedent`
        const source = { nested: { width: 304 }, omitted: true };
        const { omitted, ...rest } = source;
        rest.nested = { width: 400 };
        const { nested: { width } } = source;
        const template = tag\`${'${width}'}\`;
      `,
    ],
    [
      'array rest',
      dedent`
        const source = [{ width: 304 }];
        const [...rest] = source;
        rest[0] = { width: 400 };
        const [{ width }] = source;
        const template = tag\`${'${width}'}\`;
      `,
    ],
  ])(
    'does not propagate a shallow %s replacement back to its source',
    (_description, code) => {
      const result = collectOxcTemplateDependencies(code, filename, true);

      expect(result.staticValues).toEqual([
        expect.objectContaining({
          value: 304,
        }),
      ]);
      expect(result.staticValueCandidates).toEqual([]);
    }
  );

  it('does not connect captured values through a dormant function reference', () => {
    const result = collectOxcTemplateDependencies(
      dedent`
        const source = { width: 304 };
        const unrelated = { value: 0 };
        function dormant() {
          return [source, unrelated];
        }
        const reference = dormant;
        reference.metadata = unrelated;
        unrelated.value = 1;
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([
      expect.objectContaining({
        value: 304,
      }),
    ]);
  });

  it('propagates an actual local function call to its captured source', () => {
    expectWidthFallback(dedent`
      const source = { width: 304 };
      function mutate() {
        source.width = 400;
      }
      mutate();
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `);
  });
});
