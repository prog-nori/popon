import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { waitWithAbort } from "./readiness.js";
import { log, errorText } from "./log.js";
export interface TTSProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>;
}
export class VoicevoxProvider implements TTSProvider {
  constructor(
    private url: string,
    private speaker: number,
    private speed = 1,
    private volume = 1,
  ) {}
  async checkAvailability(): Promise<void> {
    try {
      const response = await fetch(`${this.url}/version`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      throw new Error(
        `VOICEVOXに接続できません。${this.url} のエンジンを起動し、VOICEVOX_URLを確認してください。`,
        { cause: error },
      );
    }
  }
  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(30000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const query = await fetch(
      `${this.url}/audio_query?${new URLSearchParams({ text, speaker: String(this.speaker) })}`,
      { method: "POST", signal: requestSignal },
    );
    if (!query.ok) throw new Error(`audio_query: ${query.status}`);
    const body = (await query.json()) as Record<string, unknown>;
    const response = await fetch(
      `${this.url}/synthesis?speaker=${this.speaker}`,
      {
        method: "POST",
        signal: requestSignal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          speedScale: this.speed,
          volumeScale: this.volume,
        }),
      },
    );
    if (!response.ok) throw new Error(`synthesis: ${response.status}`);
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.toString("ascii", 0, 4) !== "RIFF")
      throw new Error("VOICEVOXがWAVを返しませんでした");
    log("synthesis", { durationMs: Math.round(performance.now() - started) });
    return wav;
  }
}
export interface EngineControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export class ProcessEngine implements EngineControl {
  private child?: ChildProcess;
  constructor(
    private executable: string,
    private args: string[],
  ) {}
  async start(): Promise<void> {
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.child.killed
    )
      return;
    if (!this.executable)
      throw new Error("VOICEVOX_EXECUTABLE を設定してください");
    const child = spawn(this.executable, this.args, {
      stdio: "ignore",
      shell: false,
      cwd: dirname(this.executable),
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        if (this.child === child) this.child = undefined;
        reject(error);
      });
    });
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = undefined;
  }
}
export type TTSState =
  "STOPPED" | "STARTING" | "WARMING" | "READY" | "STOPPING" | "ERROR";
export class TTSLifecycleManager {
  state: TTSState = "STOPPED";
  private active = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private startController?: AbortController;
  private stopping?: Promise<void>;
  constructor(
    private provider: TTSProvider,
    private engine: EngineControl,
    private idleMs: number,
    private startMs: number,
  ) {}
  async acquire(id: string): Promise<void> {
    this.active.add(id);
    clearTimeout(this.timer);
    await this.stopping;
    if (!this.active.has(id)) throw new Error("VOICEVOXの準備を中止しました");
    if (this.pending && this.startController?.signal.aborted)
      await this.pending.catch(() => {});
    if (!this.active.has(id)) throw new Error("VOICEVOXの準備を中止しました");
    if (this.state === "READY") return;
    if (!this.pending) {
      this.startController = new AbortController();
      this.pending = this.start(this.startController.signal).finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }
  release(id: string): void {
    this.active.delete(id);
    if (!this.active.size) {
      this.startController?.abort();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.stop().catch((e) =>
          log("tts_stop_error", { error: errorText(e) }),
        );
      }, this.idleMs);
    }
  }
  private async start(cancel: AbortSignal): Promise<void> {
    const began = performance.now();
    this.state = "STARTING";
    log("tts_state", { state: this.state });
    const timeout = AbortSignal.timeout(this.startMs);
    const signal = AbortSignal.any([cancel, timeout]);
    let lastError: unknown;
    try {
      await waitWithAbort(this.engine.start(), signal);
      this.state = "WARMING";
      log("tts_state", { state: this.state });
      while (true) {
        signal.throwIfAborted();
        try {
          await waitWithAbort(
            this.provider.synthesize("準備できました", signal),
            signal,
          );
          break;
        } catch (error) {
          if (signal.aborted) {
            if (cancel.aborted) cancel.throwIfAborted();
            throw new Error(
              `VOICEVOXの音声合成が準備時間内に完了しませんでした: ${errorText(lastError ?? error)}`,
              { cause: error },
            );
          }
          if (!lastError) log("tts_warmup_error", { error: errorText(error) });
          lastError = error;
          await sleep(500, undefined, { signal });
        }
      }
      this.state = "READY";
      log("tts_ready", { durationMs: Math.round(performance.now() - began) });
    } catch (e) {
      this.state = "ERROR";
      if (timeout.aborted && !cancel.aborted)
        throw new Error(
          `VOICEVOXの準備が時間内に完了しませんでした: ${errorText(lastError ?? e)}`,
          { cause: e },
        );
      throw e;
    }
  }
  async stop(): Promise<void> {
    clearTimeout(this.timer);
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      await this.pending?.catch(() => undefined);
      if (this.active.size) return;
      this.state = "STOPPING";
      try {
        await this.engine.stop();
        this.state = "STOPPED";
      } catch (e) {
        this.state = "ERROR";
        throw e;
      }
      log("tts_state", { state: this.state });
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
