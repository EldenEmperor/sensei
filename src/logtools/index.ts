// Register the whole log-tool family.

import type { ToolRegistry } from '../tools/registry.js';
import { registerLogBaseline } from './baseline.js';
import { registerLogInvestigate } from './investigate.js';
import { registerLogSearch } from './search.js';
import { registerLogSlice } from './slice.js';
import { registerLogStats } from './stats.js';
import { registerLogTimeline } from './timeline.js';
import { registerLogTrace } from './trace.js';

export function registerLogTools(registry: ToolRegistry): void {
  registerLogSlice(registry);
  registerLogStats(registry);
  registerLogTimeline(registry);
  registerLogTrace(registry);
  registerLogBaseline(registry);
  registerLogSearch(registry);
  registerLogInvestigate(registry);
}
