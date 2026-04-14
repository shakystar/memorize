import type { StartupContextPayload } from '../domain/entities.js';

export interface AdapterRuntime {
  name: string;
  renderStartupContext(payload: StartupContextPayload): string;
}
