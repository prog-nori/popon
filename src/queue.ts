import { errorText, log } from "./log.js";
export interface SpeechJob {
  id: string;
  name: string;
  content: string;
  attachments: string[];
  receivedAt: number;
}
export class SpeechQueue {
  private jobs: SpeechJob[] = [];
  private seen = new Set<string>();
  private running = false;
  private ready = false;
  private controller = new AbortController();
  constructor(
    private process: (job: SpeechJob, signal: AbortSignal) => Promise<void>,
    private limit = 20,
  ) {}
  push(job: SpeechJob): "accepted" | "duplicate" | "full" | "closed" {
    if (this.controller.signal.aborted) return "closed";
    if (this.seen.has(job.id)) return "duplicate";
    if (this.jobs.length >= this.limit) return "full";
    this.seen.add(job.id);
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.values().next().value!);
    this.jobs.push(job);
    void this.drain();
    return "accepted";
  }
  start(): void {
    this.ready = true;
    void this.drain();
  }
  close(): void {
    this.controller.abort();
    this.jobs = [];
    this.seen.clear();
  }
  private async drain(): Promise<void> {
    if (this.running || !this.ready || this.controller.signal.aborted) return;
    this.running = true;
    try {
      while (this.jobs.length && !this.controller.signal.aborted) {
        const job = this.jobs.shift()!;
        try {
          await this.process(job, this.controller.signal);
        } catch (e) {
          log("job_error", { messageId: job.id, error: errorText(e) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
