import type { Comment, DegradedEntry } from "../schema.js";
import type { ToolFinding } from "../runners/types.js";
import type { RunnerOutput } from "./runner.js";

/**
 * In-memory accumulator for runner outputs (ADR-0023 #4). The Map is keyed
 * by runner name and bounded by *runner count* — pathological-diff memory
 * pressure scales with findings volume identically across storage shapes
 * and is solved upstream by M9's noise filter, not here.
 *
 * The class abstraction preserves the SQLite swap-point for M11+ daemon
 * scenarios where crash-recovery has a real consumer; v0 stays in-memory.
 *
 * `record()` overwrites by name — same runner running twice (e.g. retry
 * after a soft failure) produces the *latest* output, not a duplicate.
 * Today no runner re-records; the semantics are documented for future use.
 */
export class Scratchpad {
  private outputs = new Map<string, RunnerOutput>();

  record(output: RunnerOutput): void {
    this.outputs.set(output.name, output);
  }

  get(name: string): RunnerOutput | undefined {
    return this.outputs.get(name);
  }

  has(name: string): boolean {
    return this.outputs.has(name);
  }

  all(): RunnerOutput[] {
    return [...this.outputs.values()];
  }

  flatten(): ToolFinding[] {
    return this.all().flatMap((o) => o.findings);
  }

  flattenQuestions(): Comment[] {
    return this.all().flatMap((o) => o.questions ?? []);
  }

  flattenDegraded(): DegradedEntry[] {
    return this.all().flatMap((o) => o.degraded);
  }
}
