import { waitWithAbort } from "../readiness.js";
import { mediaErrorMessage } from "./dependencies.js";
import { errorText, log } from "../log.js";
import type { Readable } from "node:stream";
import type { MediaAdapter } from "./youtube.js";
interface Job {
  url: string;
  notify: (message: string) => Promise<unknown>;
}
export class MediaQueue {
  private jobs: Job[] = [];
  private controller = new AbortController();
  private running = false;
  private ready = false;
  constructor(
    private adapter: MediaAdapter,
    private play: (
      stream: Readable,
      signal: AbortSignal,
      onStart?: () => void,
    ) => Promise<void>,
  ) {}
  push(url: string, notify: Job["notify"]): number {
    if (this.controller.signal.aborted)
      throw new Error("セッションが終了しています。");
    if (this.jobs.length >= 20)
      throw new Error("動画の再生待ちは20件までです。");
    this.jobs.push({ url, notify });
    const position = this.jobs.length;
    log("media_queued", { url, position });
    void this.drain();
    return position;
  }
  start(): void {
    this.ready = true;
    void this.drain();
  }
  close(): void {
    this.controller.abort();
    this.jobs = [];
  }
  private async drain(): Promise<void> {
    if (this.running || !this.ready || this.controller.signal.aborted) return;
    this.running = true;
    try {
      while (this.jobs.length && !this.controller.signal.aborted) {
        const job = this.jobs.shift()!;
        const controller = new AbortController();
        // Wall-clock bound also covers stalled network/decode and prolonged connection loss.
        const signal = AbortSignal.any([
          this.controller.signal,
          controller.signal,
          AbortSignal.timeout(7500000),
        ]);
        let source: Awaited<ReturnType<MediaAdapter["open"]>> | undefined;
        try {
          log("media_fetching", { url: job.url });
          source = await this.adapter.open(job.url, signal);
          const stream = source.stream;
          const playback = Promise.resolve().then(() =>
            this.play(stream, signal, () =>
              log("media_started", { url: job.url }),
            ),
          );
          // Observe acquisition/decode errors, but only output completion
          // advances the queue. A lingering child process must not hold it up.
          await waitWithAbort(
            Promise.race([playback, source.done.then(() => playback)]),
            signal,
          );
          log("media_finished", { url: job.url });
        } catch (error) {
          if (!this.controller.signal.aborted) {
            log("media_error", { url: job.url, error: errorText(error) });
            void job
              .notify(
                `動画を再生できませんでした。${mediaErrorMessage(error)}後続の動画へ進みます。\n${job.url}`,
              )
              .catch((error) =>
                log("notification_error", { error: errorText(error) }),
              );
          }
        } finally {
          controller.abort();
          try {
            source?.stop();
          } catch (error) {
            log("media_cleanup_error", {
              url: job.url,
              error: errorText(error),
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
