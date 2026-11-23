import { log } from "./log.js";

export interface IdleOptions {
  enabled: boolean;
  coordinated: boolean;
  idleMs: number;
  busy: () => boolean;
  queueEmpty: () => Promise<boolean>;
  scale: (count: number) => Promise<void>;
  stopped: () => void;
  now?: () => number;
}

/**
 * Local checks reduce races; they cannot atomically fence an external Lambda's
 * UpdateService call. Refuse automatic scale-in without external coordination.
 */
export class IdleStopper {
  private lastActivity: number;
  private epoch = 0;
  private wasBusy = false;
  private closed = false;
  private checking = false;
  private reported = false;
  constructor(private options: IdleOptions) {
    this.lastActivity = this.now();
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  touch(): void {
    this.lastActivity = this.now();
    this.epoch++;
  }
  close(): void {
    this.closed = true;
  }
  async check(): Promise<void> {
    if (this.closed || this.checking || !this.options.enabled) return;
    if (!this.options.coordinated) {
      if (!this.reported)
        log("auto_stop_blocked", { reason: "external_coordination_required" });
      this.reported = true;
      return;
    }
    if (this.options.busy()) {
      this.wasBusy = true;
      this.touch();
      return;
    }
    if (this.wasBusy) {
      this.wasBusy = false;
      this.touch();
    }
    if (this.now() - this.lastActivity < this.options.idleMs) return;
    const epoch = this.epoch;
    this.checking = true;
    let scalingAttempted = false;
    try {
      if (!(await this.options.queueEmpty())) {
        this.touch();
        return;
      }
      if (this.closed || this.options.busy() || epoch !== this.epoch) return;
      scalingAttempted = true;
      await this.options.scale(0);
      if (this.closed) return;
      // Best effort only. External coordination must cover process termination.
      if (
        !(await this.options.queueEmpty()) ||
        this.options.busy() ||
        epoch !== this.epoch
      ) {
        await this.options.scale(1);
        this.touch();
        return;
      }
      this.closed = true;
      log("service_idle_stop_requested");
      this.options.stopped();
    } catch {
      if (this.closed) return;
      if (scalingAttempted) {
        try {
          await this.options.scale(1);
        } catch {
          log("service_idle_restore_failed");
        }
      }
      this.touch();
      log("service_idle_stop_failed");
    } finally {
      this.checking = false;
    }
  }
}
