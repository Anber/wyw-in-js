import generator from '@babel/generator';
import type { NodePath } from '@babel/traverse';

const generate =
  (generator as unknown as { default?: typeof generator }).default ?? generator;

export const getSource = (path: NodePath, force = false): string => {
  if (path.isIdentifier()) {
    // Fast-lane for identifiers
    return path.node.name;
  }

  let source: string | undefined;
  try {
    source = force ? undefined : path.getSource();
    // eslint-disable-next-line no-empty
  } catch {}

  source = source || generate(path.node).code;

  return path.node.extra?.parenthesized ? `(${source})` : source;
};
