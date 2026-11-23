import { log } from "./log.js";

export type StopReason = "leave" | "voice_empty";
interface Candidate {
  reason: StopReason;
  guildId: string;
  valid: () => boolean;
}
export interface AutoStopOptions {
  enabled: boolean;
  safe: () => boolean;
  queueEmpty: () => Promise<boolean>;
  stop: () => Promise<void>;
}

/** Invoked only after a real empty SQS poll. Checks reduce, not eliminate, races. */
export class AutoStopper {
  private candidate?: Candidate;
  private epoch = 0;
  private checking = false;
  private committing = false;
  private requested = false;
  constructor(private options: AutoStopOptions) {}
  get isStopping(): boolean {
    return this.committing || this.requested;
  }
  request(reason: StopReason, guildId: string, valid = () => true): void {
    if (!this.options.enabled || this.isStopping) return;
    this.epoch++;
    this.candidate = { reason, guildId, valid };
  }
  cancel(cause: string): void {
    this.epoch++;
    if (this.candidate)
      log("auto_stop_cancelled", {
        reason: this.candidate.reason,
        guildId: this.candidate.guildId,
        cause,
        requestInFlight: this.committing,
      });
    this.candidate = undefined;
  }
  revalidate(): void {
    if (this.candidate && !this.candidate.valid())
      this.cancel("condition_changed");
  }
  async check(): Promise<void> {
    const candidate = this.candidate;
    if (!this.options.enabled || !candidate || this.checking || this.isStopping)
      return;
    const fields = { reason: candidate.reason, guildId: candidate.guildId };
    const safe = this.options.safe() && candidate.valid();
    log("auto_stop_condition_checked", { ...fields, safe, phase: "local" });
    if (!safe) return;
    const epoch = this.epoch;
    this.checking = true;
    try {
      // This is additional evidence, not an atomic lock with the Lambda producer.
      const empty = await this.options.queueEmpty();
      const unchanged = epoch === this.epoch && candidate === this.candidate;
      const ready =
        empty && unchanged && this.options.safe() && candidate.valid();
      log("auto_stop_condition_checked", {
        ...fields,
        safe: ready,
        phase: "queue",
      });
      if (!ready) return;
      this.committing = true;
      await this.options.stop();
      this.requested = true;
      log("auto_stop_requested", fields);
      // ECS sends SIGTERM. Do not exit, StopTask, or issue desiredCount=1 here.
      this.candidate = undefined;
    } catch {
      // Fail closed and keep the Bot alive. No unbounded stop retries.
      this.candidate = undefined;
      log("auto_stop_failed", fields);
    } finally {
      this.committing = false;
      this.checking = false;
    }
  }
}
