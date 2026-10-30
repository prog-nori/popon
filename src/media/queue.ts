import { waitWithAbort } from "../readiness.js";
import { mediaErrorMessage } from "./dependencies.js";
import { errorText, log } from "../log.js";
import type { Readable } from "node:stream";
import type { MediaAdapter } from "./youtube.js";
export interface MediaListItem {
  url: string;
  title?: string;
}
interface Job extends MediaListItem {
  titleRequest?: Promise<void>;
  notify: (message: string) => Promise<unknown>;
}
export class MediaQueue {
  private jobs: Job[] = [];
  private controller = new AbortController();
  private running = false;
  private ready = false;
  private paused = false;
  private current?: { job: Job; controller: AbortController };
  constructor(
    private adapter: MediaAdapter,
    private play: (
      stream: Readable,
      signal: AbortSignal,
      onStart?: () => void,
    ) => Promise<void>,
    private setPaused: (paused: boolean) => void = () => {},
  ) {}
  snapshot(): { current?: string; paused: boolean; waiting: string[] } {
    return {
      current: this.current?.job.url,
      paused: this.paused,
      waiting: this.jobs.map((job) => job.url),
    };
  }
  async list(): Promise<{
    current?: MediaListItem;
    paused: boolean;
    waiting: MediaListItem[];
  }> {
    // At most 21 bounded requests; share pending work across concurrent /list calls.
    const jobs = [...(this.current ? [this.current.job] : []), ...this.jobs];
    await Promise.all(
      jobs.map((job) => {
        if (job.title || !this.adapter.title) return;
        if (!job.titleRequest) {
          job.titleRequest = this.adapter
            .title(job.url, this.controller.signal)
            .then((title) => {
              job.title = title;
            })
            .catch(() => {})
            .finally(() => {
              job.titleRequest = undefined;
            });
        }
        return job.titleRequest;
      }),
    );
    const item = (job: Job): MediaListItem => ({
      url: job.url,
      title: job.title,
    });
    // Playback can advance while metadata is loading; show the latest queue.
    return {
      current: this.current ? item(this.current.job) : undefined,
      paused: this.paused,
      waiting: this.jobs.map(item),
    };
  }
  pause(): boolean {
    if (!this.current || this.paused) return false;
    this.paused = true;
    this.setPaused(true);
    return true;
  }
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    this.setPaused(false);
    void this.drain();
    return true;
  }
  skip(): boolean {
    if (!this.current || this.current.controller.signal.aborted) return false;
    this.current.controller.abort();
    this.paused = false;
    this.setPaused(false);
    return true;
  }
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
    if (
      this.running ||
      !this.ready ||
      this.paused ||
      this.controller.signal.aborted
    )
      return;
    this.running = true;
    try {
      while (
        this.jobs.length &&
        !this.paused &&
        !this.controller.signal.aborted
      ) {
        const job = this.jobs.shift()!;
        const controller = new AbortController();
        this.current = { job, controller };
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
          if (!this.controller.signal.aborted && !controller.signal.aborted) {
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
          this.current = undefined;
          this.paused = false;
          this.setPaused(false);
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
