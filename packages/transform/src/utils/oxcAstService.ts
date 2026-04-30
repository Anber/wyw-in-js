import type {
  ArrayExpression,
  ArrowFunctionExpression,
  AstService,
  BaseAstNode,
  BlockStatement,
  BooleanLiteral,
  CallExpression,
  Expression,
  Identifier,
  MemberExpression,
  NullLiteral,
  NumericLiteral,
  ObjectExpression,
  ObjectProperty,
  StringLiteral,
} from '@wyw-in-js/processor-utils';

export type AddedImport = {
  imported: 'default' | string;
  local: string;
  source: string;
};

export type OxcAstService = AstService & {
  getAddedImports(): AddedImport[];
};

const createIdentifier = (name: string): Identifier => ({
  name,
  type: 'Identifier',
});

const createNameAllocator = (usedNames: Iterable<string>) => {
  const used = new Set(usedNames);

  return (hint: string): string => {
    let candidate = hint.replace(/[^A-Za-z0-9_$]/g, '_') || '_import';
    if (!/^[A-Za-z_$]/.test(candidate)) {
      candidate = `_${candidate}`;
    }

    let next = candidate;
    let idx = 2;
    while (used.has(next)) {
      next = `${candidate}${idx}`;
      idx += 1;
    }

    used.add(next);
    return next;
  };
};

export const createOxcAstService = (
  usedNames: Iterable<string> = []
): OxcAstService => {
  const addedImports: AddedImport[] = [];
  const allocateName = createNameAllocator(usedNames);

  return {
    addDefaultImport(source: string, nameHint = 'defaultImport'): Identifier {
      const local = allocateName(nameHint);
      addedImports.push({ imported: 'default', local, source });
      return createIdentifier(local);
    },

    addNamedImport(
      name: string,
      source: string,
      nameHint: string = name
    ): Identifier {
      const local = allocateName(nameHint);
      addedImports.push({ imported: name, local, source });
      return createIdentifier(local);
    },

    arrayExpression(elements: (Expression | null)[]): ArrayExpression {
      return { elements, type: 'ArrayExpression' };
    },

    arrowFunctionExpression(
      params: Identifier[],
      body: BlockStatement | Expression
    ): ArrowFunctionExpression {
      return { body, params, type: 'ArrowFunctionExpression' };
    },

    blockStatement(body: BaseAstNode[]): BlockStatement {
      return { body, type: 'BlockStatement' };
    },

    booleanLiteral(value: boolean): BooleanLiteral {
      return { type: 'BooleanLiteral', value };
    },

    callExpression(callee: Expression, args: Expression[]): CallExpression {
      return { arguments: args, callee, type: 'CallExpression' };
    },

    getAddedImports(): AddedImport[] {
      return [...addedImports];
    },

    identifier(name: string): Identifier {
      return createIdentifier(name);
    },

    memberExpression(
      object: Expression,
      property: Expression,
      computed = false
    ): MemberExpression {
      return { computed, object, property, type: 'MemberExpression' };
    },

    nullLiteral(): NullLiteral {
      return { type: 'NullLiteral' };
    },

    numericLiteral(value: number): NumericLiteral {
      return { type: 'NumericLiteral', value };
    },

    objectExpression(properties: ObjectProperty[]): ObjectExpression {
      return { properties, type: 'ObjectExpression' };
    },

    objectProperty(key: Expression, value: Expression): ObjectProperty {
      return { key, type: 'ObjectProperty', value };
    },

    stringLiteral(value: string): StringLiteral {
      return { type: 'StringLiteral', value };
    },
  };
};

export const printOxcAstServiceImport = ({
  imported,
  local,
  source,
}: AddedImport): string =>
  imported === 'default'
    ? `import ${local} from ${JSON.stringify(source)};`
    : `import { ${imported}${
        imported === local ? '' : ` as ${local}`
      } } from ${JSON.stringify(source)};`;
