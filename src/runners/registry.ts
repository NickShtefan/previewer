import type { Runner, RunnerRegistry } from "../core";
import type { RunnerCapabilities, RunnerSelector } from "../config";

/** In-memory runner registry. Cost/quality selection logic is refined in M9. */
export class DefaultRunnerRegistry implements RunnerRegistry {
  private readonly runners = new Map<string, Runner>();

  register(runner: Runner): void {
    // A runner carries its id twice — `runner.id` and `capabilities.id` — and only the latter
    // reaches config validation (via `all()`). If they drift, a repo can be validated against
    // one id and dispatched by another; renaming just one would leave every test green.
    if (runner.id !== runner.capabilities.id) {
      throw new Error(
        `Runner id mismatch: class id "${runner.id}" != capabilities.id "${runner.capabilities.id}". ` +
          `Config validation reads capabilities.id, dispatch uses the class id — they must agree.`,
      );
    }
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
