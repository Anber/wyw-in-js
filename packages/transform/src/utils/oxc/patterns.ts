import type { Expression, Node } from 'oxc-parser';

export type OxcBindingIdentifier = Extract<Node, { type: 'Identifier' }>;
export type OxcPatternProperty = Extract<Node, { type: 'Property' }>;
export type OxcRestElement = Extract<Node, { type: 'RestElement' }>;

export type OxcBindingPatternFact =
  | Readonly<{
      identifier: OxcBindingIdentifier;
      kind: 'binding';
      order: number;
    }>
  | Readonly<{
      expression: Expression;
      kind: 'computed-key';
      order: number;
    }>
  | Readonly<{
      expression: Expression;
      kind: 'default';
      order: number;
    }>
  | Readonly<{
      kind: 'rest';
      node: OxcRestElement;
      order: number;
    }>;

export type OxcBindingPatternFacts = Readonly<{
  bindingIdentifiers: readonly OxcBindingIdentifier[];
  bindingNames: readonly string[];
  facts: readonly OxcBindingPatternFact[];
  nodes: readonly Node[];
  runtimeExpressions: readonly Expression[];
  shorthandProperties: readonly OxcPatternProperty[];
}>;

type OxcBindingPatternVisitor = {
  binding?: (identifier: OxcBindingIdentifier) => void;
  computedKey?: (expression: Expression) => void;
  defaultValue?: (expression: Expression) => void;
  node?: (node: Node) => void;
  rest?: (node: OxcRestElement) => void;
  shorthand?: (property: OxcPatternProperty) => void;
};

const visitOxcBindingPatternInternal = (
  pattern: Node | null | undefined,
  visitor: OxcBindingPatternVisitor
): void => {
  if (!pattern) {
    return;
  }

  visitor.node?.(pattern);

  if (pattern.type === 'Identifier') {
    visitor.binding?.(pattern);
    return;
  }

  if (pattern.type === 'TSParameterProperty') {
    visitOxcBindingPatternInternal(pattern.parameter, visitor);
    return;
  }

  if (pattern.type === 'AssignmentPattern') {
    visitor.defaultValue?.(pattern.right);
    visitOxcBindingPatternInternal(pattern.left, visitor);
    return;
  }

  if (pattern.type === 'RestElement') {
    visitor.rest?.(pattern);
    visitOxcBindingPatternInternal(pattern.argument, visitor);
    return;
  }

  if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((property) => {
      if (property.type === 'RestElement') {
        visitOxcBindingPatternInternal(property, visitor);
        return;
      }

      if (property.shorthand) {
        visitor.shorthand?.(property);
      }
      if (property.computed) {
        visitor.computedKey?.(property.key as Expression);
      }
      visitOxcBindingPatternInternal(property.value, visitor);
    });
    return;
  }

  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element) => {
      if (element) {
        visitOxcBindingPatternInternal(element, visitor);
      }
    });
  }
};

export const visitOxcBindingPattern = (
  pattern: Node | null | undefined,
  visitor: OxcBindingPatternVisitor
): void => visitOxcBindingPatternInternal(pattern, visitor);

const emptyBindingPatternFacts: OxcBindingPatternFacts = {
  bindingIdentifiers: [],
  bindingNames: [],
  facts: [],
  nodes: [],
  runtimeExpressions: [],
  shorthandProperties: [],
};

type OxcBindingPatternFactsCache = {
  bindingIdentifiers?: readonly OxcBindingIdentifier[];
  bindingNames?: readonly string[];
  complete?: OxcBindingPatternFacts;
  nodes?: readonly Node[];
  runtimeExpressions?: readonly Expression[];
  shorthandProperties?: readonly OxcPatternProperty[];
};

const bindingPatternFactsCache = new WeakMap<
  Node,
  OxcBindingPatternFactsCache
>();

const getBindingPatternFactsCache = (
  pattern: Node
): OxcBindingPatternFactsCache => {
  const cached = bindingPatternFactsCache.get(pattern);
  if (cached) {
    return cached;
  }

  const created: OxcBindingPatternFactsCache = {};
  bindingPatternFactsCache.set(pattern, created);
  return created;
};

export const getOxcBindingPatternFacts = (
  pattern: Node | null | undefined
): OxcBindingPatternFacts => {
  if (!pattern) {
    return emptyBindingPatternFacts;
  }

  const cached = getBindingPatternFactsCache(pattern);
  if (cached.complete) {
    return cached.complete;
  }

  const bindingIdentifiers: OxcBindingIdentifier[] = [];
  const facts: OxcBindingPatternFact[] = [];
  const nodes: Node[] = [];
  const runtimeExpressions: Expression[] = [];
  const shorthandProperties: OxcPatternProperty[] = [];
  let order = 0;
  visitOxcBindingPatternInternal(pattern, {
    binding: (identifier) => {
      bindingIdentifiers.push(identifier);
      facts.push({ identifier, kind: 'binding', order });
      order += 1;
    },
    computedKey: (expression) => {
      runtimeExpressions.push(expression);
      facts.push({ expression, kind: 'computed-key', order });
      order += 1;
    },
    defaultValue: (expression) => {
      runtimeExpressions.push(expression);
      facts.push({ expression, kind: 'default', order });
      order += 1;
    },
    node: (node) => nodes.push(node),
    rest: (node) => {
      facts.push({ kind: 'rest', node, order });
      order += 1;
    },
    shorthand: (property) => shorthandProperties.push(property),
  });

  const result: OxcBindingPatternFacts = {
    bindingIdentifiers,
    bindingNames: bindingIdentifiers.map(({ name }) => name),
    facts,
    nodes,
    runtimeExpressions,
    shorthandProperties,
  };
  cached.bindingIdentifiers = bindingIdentifiers;
  cached.bindingNames = result.bindingNames;
  cached.complete = result;
  cached.nodes = nodes;
  cached.runtimeExpressions = runtimeExpressions;
  cached.shorthandProperties = shorthandProperties;
  return result;
};

const getOxcPatternBindingFacts = (
  pattern: Node | null | undefined
): Pick<OxcBindingPatternFacts, 'bindingIdentifiers' | 'bindingNames'> => {
  if (!pattern) {
    return emptyBindingPatternFacts;
  }

  const cached = getBindingPatternFactsCache(pattern);
  if (cached.bindingIdentifiers && cached.bindingNames) {
    return {
      bindingIdentifiers: cached.bindingIdentifiers,
      bindingNames: cached.bindingNames,
    };
  }

  const bindingIdentifiers: OxcBindingIdentifier[] = [];
  visitOxcBindingPatternInternal(pattern, {
    binding: (identifier) => bindingIdentifiers.push(identifier),
  });
  const bindingNames = bindingIdentifiers.map(({ name }) => name);
  cached.bindingIdentifiers = bindingIdentifiers;
  cached.bindingNames = bindingNames;
  return { bindingIdentifiers, bindingNames };
};

export const collectOxcPatternIdentifiers = (
  pattern: Node | null | undefined
): readonly OxcBindingIdentifier[] =>
  getOxcPatternBindingFacts(pattern).bindingIdentifiers;

export const collectOxcPatternIdentifierNames = (
  pattern: Node | null | undefined
): readonly string[] => getOxcPatternBindingFacts(pattern).bindingNames;

export const collectOxcPatternBindingIdentifiers = collectOxcPatternIdentifiers;

export const collectOxcPatternBindingNames = collectOxcPatternIdentifierNames;

export const collectOxcPatternRuntimeExpressions = (
  pattern: Node | null | undefined
): readonly Expression[] => {
  if (!pattern) {
    return emptyBindingPatternFacts.runtimeExpressions;
  }

  const cached = getBindingPatternFactsCache(pattern);
  if (cached.runtimeExpressions) {
    return cached.runtimeExpressions;
  }

  const runtimeExpressions: Expression[] = [];
  visitOxcBindingPatternInternal(pattern, {
    computedKey: (expression) => runtimeExpressions.push(expression),
    defaultValue: (expression) => runtimeExpressions.push(expression),
  });
  cached.runtimeExpressions = runtimeExpressions;
  return runtimeExpressions;
};

export const collectOxcPatternShorthandProperties = (
  pattern: Node | null | undefined
): readonly OxcPatternProperty[] => {
  if (!pattern) {
    return emptyBindingPatternFacts.shorthandProperties;
  }

  const cached = getBindingPatternFactsCache(pattern);
  if (cached.shorthandProperties) {
    return cached.shorthandProperties;
  }

  const shorthandProperties: OxcPatternProperty[] = [];
  visitOxcBindingPatternInternal(pattern, {
    shorthand: (property) => shorthandProperties.push(property),
  });
  cached.shorthandProperties = shorthandProperties;
  return shorthandProperties;
};

export const someOxcPatternNode = (
  pattern: Node | null | undefined,
  predicate: (node: Node) => boolean
): boolean => {
  if (!pattern) {
    return false;
  }

  const cached = getBindingPatternFactsCache(pattern);
  if (!cached.nodes) {
    const nodes: Node[] = [];
    visitOxcBindingPatternInternal(pattern, {
      node: (node) => nodes.push(node),
    });
    cached.nodes = nodes;
  }
  return cached.nodes.some(predicate);
};
