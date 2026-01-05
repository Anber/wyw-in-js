import type { NodePath } from '@babel/traverse';
import type { MemberExpression, OptionalMemberExpression } from '@babel/types';

import type { Core } from '../babel';

const IMPORT_META_ENV = '__wyw_import_meta_env';

type MemberExpressionNode = MemberExpression | OptionalMemberExpression;

type ImportMetaLike = {
  meta: { name: string };
  property: { name: string };
};

const isRecord = (obj: unknown): obj is Record<string, unknown> =>
  typeof obj === 'object' && obj !== null;

function isImportMeta(obj: unknown): obj is ImportMetaLike {
  if (!isRecord(obj)) {
    return false;
  }

  const { meta, property } = obj;

  if (!isRecord(meta) || !isRecord(property)) {
    return false;
  }

  return meta.name === 'import' && property.name === 'meta';
}

function isImportMetaEnv(node: MemberExpressionNode): boolean {
  const { computed, object, property } = node;

  if (computed) {
    return false;
  }

  if (!isImportMeta(object)) {
    return false;
  }

  return property.type === 'Identifier' && property.name === 'env';
}

export function replaceImportMetaEnv(
  programPath: NodePath,
  t: Core['types']
): void {
  programPath.traverse({
    MemberExpression(path) {
      if (isImportMetaEnv(path.node)) {
        path.replaceWith(t.identifier(IMPORT_META_ENV));
      }
    },
    OptionalMemberExpression(path) {
      if (isImportMetaEnv(path.node)) {
        path.replaceWith(t.identifier(IMPORT_META_ENV));
      }
    },
  });
}
