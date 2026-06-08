import type { LiveUpdate, StartupContextPayload } from '../domain/entities.js';

export interface AdapterRuntime {
  name: string;
  renderStartupContext(payload: StartupContextPayload): string;
  /** CLS Phase 2 — render a parallel-session live update for injection via a
   *  mid-session hook's additionalContext. */
  renderLiveUpdate(update: LiveUpdate): string;
}
