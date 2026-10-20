/**
 * Records which steps of one `streamText` call stopped at the output token
 * limit (`finishReason === "length"`).
 *
 * A step that stops at the limit has an incomplete output: a cut-off tool
 * call input or a cut-off structured output. The AI SDK does not stop the
 * tool loop for this, so the boss and the workers check it themselves. They
 * must not report a clean result from a call that was cut off (ADR-0030
 * amendment 2026-10-20, Anthropic max output).
 *
 * Wire it with `onStepFinish`, next to `CallUsageMeter.onStepFinish`.
 */
export class OutputCutoffLog {
  private stepCount = 0;
  private readonly cut: number[] = [];

  /** `streamText({ onStepFinish })` hook. */
  readonly onStepFinish = (step: { readonly finishReason: string }): void => {
    this.stepCount += 1;
    if (step.finishReason === "length") this.cut.push(this.stepCount);
  };

  /** True when the last finished step stopped at the output token limit. */
  lastStepCut(): boolean {
    return this.stepCount > 0 && this.cut.at(-1) === this.stepCount;
  }

  /**
   * A short description of the cut-off steps (1-based step numbers), or
   * `undefined` when no step was cut off.
   */
  describe(): string | undefined {
    if (this.cut.length === 0) return undefined;
    const label = this.cut.length === 1 ? "step" : "steps";
    return `output cut off at the max output token limit (finishReason "length") at ${label} ${this.cut.join(", ")}`;
  }
}
