import type { Expression, Node } from 'oxc-parser';

import { findResolvedReferences as getReferences } from './bindingResolution';
import { someExecutionAncestorEffect } from './mutationExecution';
import * as timeline from './mutationTimeline';
import {
  getBindingDirectTimeline,
  getBindingHazardTimeline,
  someHazardTimelineEndAtOrBefore,
} from './staticEvaluationSafety';
import type { EvalEnv } from './staticEvaluationRuntime';
import type { Binding, ExtractionContext } from './types';

type StaticCallPurity = (
  node: Node,
  ctx: ExtractionContext,
  env: EvalEnv
) => boolean;

export const hasReferencedRootMutationBetween = (
  expression: Expression,
  start: number,
  end: number,
  ctx: ExtractionContext,
  env: EvalEnv,
  isKnownPure: StaticCallPurity
): boolean =>
  getReferences(expression, ctx.bindingIndex).some(
    ({ binding }) =>
      !!binding &&
      (timeline.hasTimelineStartInRange(
        getBindingDirectTimeline(binding, ctx),
        start,
        end
      ) ||
        (() => {
          const hazards = getBindingHazardTimeline(binding, ctx);
          const isImpure = (hazard: Node) => !isKnownPure(hazard, ctx, env);
          return (
            timeline.someTimelineFullyContained(
              hazards,
              start,
              end,
              isImpure
            ) ||
            someExecutionAncestorEffect(
              ctx.bindingIndex,
              hazards,
              end,
              isImpure
            )
          );
        })())
  );

export const hasReferencedRootMutationHazardBefore = (
  expression: Expression,
  end: number,
  ctx: ExtractionContext,
  ignoredHazard: Node | undefined,
  env: EvalEnv,
  isKnownPure: StaticCallPurity
): boolean =>
  ctx.rootMutationHazardsByBinding.size > 0 &&
  getReferences(expression, ctx.bindingIndex).some(
    ({ binding }) =>
      !!binding &&
      someHazardTimelineEndAtOrBefore(
        getBindingHazardTimeline(binding, ctx),
        end,
        ctx,
        (hazard) =>
          !isKnownPure(hazard, ctx, env) &&
          (!ignoredHazard ||
            hazard.start < ignoredHazard.start ||
            ignoredHazard.end < hazard.end)
      )
  );

export const hasBindingMutationHazardBetween = (
  binding: Binding,
  start: number,
  end: number,
  ctx: ExtractionContext,
  env: EvalEnv,
  isKnownPure: StaticCallPurity
): boolean =>
  (() => {
    const hazards = getBindingHazardTimeline(binding, ctx);
    const isImpure = (hazard: Node) => !isKnownPure(hazard, ctx, env);
    return (
      timeline.someTimelineFullyContained(hazards, start, end, isImpure) ||
      someExecutionAncestorEffect(ctx.bindingIndex, hazards, end, isImpure)
    );
  })();

export const hasBindingMutationBefore = (
  binding: Binding,
  end: number,
  ctx: ExtractionContext,
  env: EvalEnv,
  isKnownPure: StaticCallPurity
): boolean =>
  timeline.hasTimelineStartBefore(
    getBindingDirectTimeline(binding, ctx),
    end
  ) ||
  someHazardTimelineEndAtOrBefore(
    getBindingHazardTimeline(binding, ctx),
    end,
    ctx,
    (hazard) => !isKnownPure(hazard, ctx, env)
  );
