import type { Node } from 'oxc-parser';

import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import { createOxcRuntimePropertyPath } from '../oxc/projections';
import {
  collectClassAccessors,
  collectClassCallables,
  collectObjectAccessors,
  collectObjectCallables,
  getCalleeBinding,
  type ClassNode,
} from './bindingProvenance';
import {
  collectMutations,
  forEachModuleExecutedNode,
  unwrapAliasExpression,
  type CallableNode,
} from './executableIndex';

type AssignmentPair = Readonly<{
  pattern: Node;
  value: Node;
}>;

type CallableSyntaxFacts = Readonly<{
  assignmentPairs: readonly AssignmentPair[];
  calleeCandidates: ReadonlySet<string>;
  localAccessors: ReadonlyMap<string, CallableNode>;
  localCallables: ReadonlyMap<string, CallableNode>;
  localClasses: ReadonlyMap<string, ClassNode>;
  mutationBindings: ReadonlySet<string>;
}>;

export type CallableSyntaxCatalogs = Readonly<{
  accessors: ReadonlyMap<string, CallableNode>;
  callables: ReadonlyMap<string, CallableNode>;
  classes: ReadonlyMap<string, ClassNode>;
}>;

const collectCallableSyntaxFacts = (body: Node): CallableSyntaxFacts => {
  const assignmentPairs: AssignmentPair[] = [];
  const calleeCandidates = new Set<string>();
  const localAccessors = new Map<string, CallableNode>();
  const localCallables = new Map<string, CallableNode>();
  const localClasses = new Map<string, ClassNode>();
  const addClass = (name: string, classNode: ClassNode): void => {
    const path = createOxcRuntimePropertyPath(name).key;
    localClasses.set(name, classNode);
    collectClassCallables(classNode, path, localCallables);
    collectClassAccessors(classNode, path, localAccessors);
  };

  forEachModuleExecutedNode(body, (current) => {
    if (current.type === 'VariableDeclaration') {
      current.declarations.forEach((declarator) => {
        if (!declarator.init) {
          return;
        }
        assignmentPairs.push({
          pattern: declarator.id,
          value: declarator.init,
        });
        if (declarator.id.type !== 'Identifier') {
          return;
        }

        const { name } = declarator.id;
        const initializer = unwrapAliasExpression(declarator.init);
        if (
          initializer.type === 'FunctionExpression' ||
          initializer.type === 'ArrowFunctionExpression'
        ) {
          localCallables.set(name, initializer as CallableNode);
        } else if (initializer.type === 'ClassExpression') {
          addClass(name, initializer as ClassNode);
        } else if (initializer.type === 'ObjectExpression') {
          const path = createOxcRuntimePropertyPath(name).key;
          collectObjectCallables(initializer, path, localCallables);
          collectObjectAccessors(initializer, path, localAccessors);
        }
      });
    } else if (
      current.type === 'AssignmentExpression' &&
      current.operator === '=' &&
      collectPatternNames(current.left).length > 0
    ) {
      assignmentPairs.push({ pattern: current.left, value: current.right });
    }

    let callee: Node | null = null;
    if (current.type === 'CallExpression' || current.type === 'NewExpression') {
      callee = current.callee;
    } else if (current.type === 'TaggedTemplateExpression') {
      callee = current.tag;
    }
    const calleeBinding = callee ? getCalleeBinding(callee) : null;
    if (calleeBinding) {
      calleeCandidates.add(calleeBinding);
    }

    if (current.type === 'FunctionDeclaration' && current.id) {
      localCallables.set(current.id.name, current as CallableNode);
    } else if (current.type === 'ClassDeclaration' && current.id) {
      addClass(current.id.name, current as ClassNode);
    }
  });

  return {
    assignmentPairs,
    calleeCandidates,
    localAccessors,
    localCallables,
    localClasses,
    mutationBindings: collectMutations(body),
  };
};

export const createCallableSyntaxFactsCache = () => {
  const cache = new WeakMap<Node, CallableSyntaxFacts>();
  return (body: Node): CallableSyntaxFacts => {
    const cached = cache.get(body);
    if (cached) {
      return cached;
    }
    const facts = collectCallableSyntaxFacts(body);
    cache.set(body, facts);
    return facts;
  };
};

const extendCatalog = <T>(
  inherited: ReadonlyMap<string, T>,
  local: ReadonlyMap<string, T>
): ReadonlyMap<string, T> => {
  const scoped = new Map(inherited);
  local.forEach((value, key) => scoped.set(key, value));
  return scoped;
};

export const extendCallableSyntaxCatalogs = (
  facts: CallableSyntaxFacts,
  inherited: CallableSyntaxCatalogs
): CallableSyntaxCatalogs => ({
  accessors: extendCatalog(inherited.accessors, facts.localAccessors),
  callables: extendCatalog(inherited.callables, facts.localCallables),
  classes: extendCatalog(inherited.classes, facts.localClasses),
});
