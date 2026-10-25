import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
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
    if (this.state === "READY") return;
    if (!this.pending)
      this.pending = this.start().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  release(id: string): void {
    this.active.delete(id);
    if (!this.active.size) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.stop().catch((e) =>
          log("tts_stop_error", { error: errorText(e) }),
        );
      }, this.idleMs);
    }
  }
  private async start(): Promise<void> {
    const began = performance.now();
    this.state = "STARTING";
    log("tts_state", { state: this.state });
    try {
      await this.engine.start();
      this.state = "WARMING";
      const signal = AbortSignal.timeout(this.startMs);
      while (true) {
        signal.throwIfAborted();
        try {
          await this.provider.synthesize("準備できました", signal);
          break;
        } catch {
          signal.throwIfAborted();
          await sleep(500, undefined, { signal });
        }
      }
      this.state = "READY";
      log("tts_ready", { durationMs: Math.round(performance.now() - began) });
    } catch (e) {
      this.state = "ERROR";
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
