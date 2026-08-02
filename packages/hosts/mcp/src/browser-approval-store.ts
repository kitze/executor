// ---------------------------------------------------------------------------
// In-process browser-approval store — the single-process equivalent of the
// Durable Object's persisted approval responses (apps/cloud, host-cloudflare).
//
// It is the bridge between the two halves of a browser approval:
//   - the MCP `resume` tool long-polls `store.waitForResponse(executionId)`,
//   - the HTTP approval endpoint records the human's decision via
//     `recordResponse(executionId, response)`, which wakes that waiter.
//
// Keyed by executionId alone — execution ids are unique per execution, so one
// store serves every session in the process. The in-memory MCP session store
// and the local app both build on it.
// ---------------------------------------------------------------------------

import { Deferred, Effect } from "effect";

import type { ResumeResponse } from "@executor-js/execution";

import type { BrowserApprovalStore } from "./tool-server";

export interface InProcessBrowserApprovalStore {
  /** The store the MCP server awaits a decision on (browser elicitation mode). */
  readonly store: BrowserApprovalStore;
  /** Record the first terminal human decision, waking an in-flight waiter.
   * Later duplicate/conflicting posts return that original decision. */
  readonly recordResponse: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ResumeResponse>;
  /** Drop a pending decision/waiter (e.g. when its session is torn down). */
  readonly forget: (executionId: string) => void;
}

export const makeInProcessBrowserApprovalStore = (): InProcessBrowserApprovalStore => {
  // Keep an immutable terminal decision until the owning live pause settles.
  // A response is not a queue item: concurrent model retries must observe the
  // same first decision, then the engine's resume cache makes execution safe.
  const decisions = new Map<string, ResumeResponse>();
  const waiters = new Map<string, Deferred.Deferred<ResumeResponse>>();

  const take = (executionId: string): Effect.Effect<ResumeResponse | null> =>
    Effect.sync(() => decisions.get(executionId) ?? null);

  const waitFor = (executionId: string): Effect.Effect<ResumeResponse | null> =>
    Effect.gen(function* () {
      const existing = yield* take(executionId);
      if (existing) return existing;

      const waiter = waiters.get(executionId) ?? (yield* Deferred.make<ResumeResponse>());
      waiters.set(executionId, waiter);
      // `take` and waiter registration are separate steps. Recheck after the
      // waiter is visible so a browser post that lands in that tiny interval
      // cannot leave this model-side resume waiting forever.
      const racedDecision = yield* take(executionId);
      if (racedDecision) return racedDecision;
      return yield* Deferred.await(waiter).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (waiters.get(executionId) === waiter) waiters.delete(executionId);
          }),
        ),
      );
    });

  const forget = (executionId: string): void => {
    decisions.delete(executionId);
    waiters.delete(executionId);
  };

  return {
    store: { takeResponse: take, waitForResponse: waitFor, forget },
    recordResponse: (executionId, response) =>
      Effect.gen(function* () {
        const finalResponse = yield* Effect.sync(() => {
          const existing = decisions.get(executionId);
          if (existing) return existing;
          decisions.set(executionId, response);
          return response;
        });
        const waiter = waiters.get(executionId);
        if (waiter) yield* Deferred.succeed(waiter, finalResponse);
        return finalResponse;
      }),
    forget,
  };
};
