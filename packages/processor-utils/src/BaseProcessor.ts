/* eslint-disable class-methods-use-this */
import type { Artifact, ExpressionValue } from '@wyw-in-js/shared';
import { hasEvalMeta } from '@wyw-in-js/shared';

import type {
  AstService,
  Expression,
  Identifier,
  MemberExpression,
  SourceLocation,
} from './ast';
import { expressionToCode } from './ast';
import { createProcessorDiagnosticArtifact } from './diagnostics';
import type { ProcessorStaticContext, ProcessorStaticValue } from './static';
import type {
  IInterpolation,
  Params,
  ProcessorDiagnostic,
  Value,
  ValueCache,
} from './types';
import getClassNameAndSlug from './utils/getClassNameAndSlug';
import { isCSSable } from './utils/toCSS';
import type { IFileContext, IOptions } from './utils/types';
import { validateParams } from './utils/validateParams';

export type { Expression };

export type ProcessorParams = ConstructorParameters<typeof BaseProcessor>;
export type TailProcessorParams = ProcessorParams extends [Params, ...infer T]
  ? T
  : never;

export type TagSource = {
  imported: string;
  source: string;
};

export abstract class BaseProcessor {
  public static SKIP = Symbol('skip');

  public readonly artifacts: Artifact[] = [];

  public readonly className: string;

  public readonly dependencies: ExpressionValue[] = [];

  public interpolations: IInterpolation[] = [];

  public readonly slug: string;

  protected callee: Identifier | MemberExpression;

  protected evaluated:
    | Record<'dependencies' | 'expression', Value[]>
    | undefined;

  public constructor(
    params: Params,
    public tagSource: TagSource,
    protected readonly astService: AstService,
    public readonly location: SourceLocation | null,
    protected readonly replacer: (
      replacement: Expression | ((tagPath: unknown) => Expression),
      isPure: boolean
    ) => void,
    public readonly displayName: string,
    public readonly isReferenced: boolean,
    protected readonly idx: number,
    protected readonly options: IOptions,
    protected readonly context: IFileContext
  ) {
    validateParams(
      params,
      ['callee'],
      'Unknown error: a callee param is not specified'
    );

    const { className, slug } = getClassNameAndSlug(
      this.displayName,
      this.idx,
      this.options,
      this.context
    );

    this.className = className;
    this.slug = slug;

    [[, this.callee]] = params;
  }

  /**
   * A replacement for tag referenced in a template literal.
   */
  public abstract get asSelector(): string;

  /**
   * A replacement for the tag in evaluation time.
   * For example, `css` tag will be replaced with its className,
   * whereas `styled` tag will be replaced with an object with metadata.
   */
  public abstract get value(): Expression;

  public addDiagnostic(diagnostic: ProcessorDiagnostic): void {
    this.artifacts.push(
      createProcessorDiagnosticArtifact({
        ...diagnostic,
        end: diagnostic.end ?? this.location?.end ?? null,
        start: diagnostic.start ?? this.location?.start ?? null,
      })
    );
  }

  /* eslint-disable @typescript-eslint/member-ordering */
  public getStaticValue?(
    context: ProcessorStaticContext
  ): ProcessorStaticValue | null | undefined;

  public resolveStaticInterpolation?(
    interpolation: IInterpolation,
    value: ProcessorStaticValue,
    context: ProcessorStaticContext
  ): ProcessorStaticValue | null | undefined;

  public resolveStaticTagTarget?(
    target: ProcessorStaticValue,
    context: ProcessorStaticContext
  ): ProcessorStaticValue | null | undefined;

  public isValidValue(value: unknown): value is Value {
    return (
      typeof value === 'function' || isCSSable(value) || hasEvalMeta(value)
    );
  }
  /* eslint-enable @typescript-eslint/member-ordering */

  public toString(): string {
    return this.tagSourceCode();
  }

  protected tagSourceCode(): string {
    return expressionToCode(this.callee);
  }

  public abstract build(values: ValueCache): void;

  /**
   * Perform a replacement for the tag in evaluation time.
   * For example, `css` tag will be replaced with its className,
   * whereas `styled` tag will be replaced with an object with metadata.
   */
  public abstract doEvaltimeReplacement(): void;

  /**
   * Perform a replacement for the tag with its runtime version.
   * For example, `css` tag will be replaced with its className,
   * whereas `styled` tag will be replaced with a component.
   * If some parts require evaluated data for render,
   * they will be replaced with placeholders.
   */
  public abstract doRuntimeReplacement(): void;
}
