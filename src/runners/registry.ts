import type { Runner, RunnerRegistry } from "../core";
import type { RunnerCapabilities, RunnerSelector } from "../config";

/** In-memory runner registry. Cost/quality selection logic is refined in M9. */
export class DefaultRunnerRegistry implements RunnerRegistry {
  private readonly runners = new Map<string, Runner>();

  register(runner: Runner): void {
    this.runners.set(runner.id, runner);
  }

  get(id: string): Runner {
    const r = this.runners.get(id);
    if (!r) throw new Error(`Runner not found: ${id}`);
    return r;
  }

  select(sel: RunnerSelector): Runner {
    // M9: honor cost_first / quality_first + repo overrides. For now: preferred id.
    return this.get(sel.preferred);
  }

  all(): RunnerCapabilities[] {
    return [...this.runners.values()].map((r) => r.capabilities);
  }
}
