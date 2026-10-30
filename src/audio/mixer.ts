import { Readable } from "node:stream";

// 48 kHz, stereo, signed 16-bit little endian; one Discord packet = 20 ms.
export const FRAME_BYTES = 3840;
// Video base gain; speech ducking is applied in addition to this level.
const MEDIA_GAIN = 0.125;
const DUCK_GAIN = 0.15;
const FADE_SAMPLES = 48000 * 0.06;
type Kind = "speech" | "media";
interface Track {
  source: Readable;
  started: boolean;
  finish: (error?: Error) => void;
  onStart?: () => void;
  lastData: number;
}

export class Mixer extends Readable {
  private tracks = new Map<Kind, Track>();
  private pending = new Set<Track>();
  private fences: { frame: number; run: () => void }[] = [];
  private frame = 0;
  private acknowledged = 0;
  private gain = 1;
  private fadeFrom = 1;
  private fadeTarget = 1;
  private fadePosition = FADE_SAMPLES;
  private timer?: ReturnType<typeof setTimeout>;
  private closedMixer = false;

  constructor() {
    super({ highWaterMark: FRAME_BYTES });
  }

  play(
    kind: Kind,
    source: Readable,
    signal: AbortSignal,
    onStart?: () => void,
  ): Promise<void> {
    if (signal.aborted || this.closedMixer || this.tracks.has(kind)) {
      source.destroy();
      return Promise.reject(new Error("音声トラックを開始できません"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => finish(new Error("再生をキャンセルしました"));
      const fail = (error: Error) => finish(error);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(track);
        signal.removeEventListener("abort", abort);
        source.off("error", fail);
        source.off("close", close);
        source.destroy();
        if (this.tracks.get(kind) === track) this.tracks.delete(kind);
        if (error) reject(error);
        else resolve();
      };
      const close = () => {
        if (!source.readableEnded)
          finish(new Error("音声ストリームが途中で終了しました"));
      };
      const track: Track = {
        source,
        started: false,
        finish,
        onStart,
        lastData: performance.now(),
      };
      this.pending.add(track);
      source.on("error", fail);
      source.on("close", close);
      signal.addEventListener("abort", abort, { once: true });
      this.tracks.set(kind, track);
    });
  }

  // Called with the transport's sent PCM packet position, never decoder EOF.
  acknowledge(frames: number): void {
    this.acknowledged = Math.max(this.acknowledged, frames);
    const ready = this.fences.filter((f) => f.frame <= frames);
    this.fences = this.fences.filter((f) => f.frame > frames);
    for (const fence of ready) fence.run();
  }

  render(): Buffer {
    const chunks = new Map<Kind, Buffer>();
    this.frame++;
    for (const [kind, track] of this.tracks) {
      const data = track.source.read(FRAME_BYTES) as Buffer | null;
      if (data?.length) {
        track.lastData = performance.now();
        chunks.set(kind, data);
        if (!track.started) {
          track.started = true;
          this.fences.push({
            frame: this.frame,
            run: () => {
              if (this.pending.has(track)) track.onStart?.();
            },
          });
        }
      } else if (track.source.readableEnded) {
        this.tracks.delete(kind);
        this.fences.push({ frame: this.frame - 1, run: () => track.finish() });
      } else if (performance.now() - track.lastData > 30000) {
        track.finish(new Error("音声入力が30秒間停止しました"));
      }
    }
    const output = Buffer.alloc(FRAME_BYTES);
    const speech = chunks.get("speech");
    const media = chunks.get("media");
    const target = speech ? DUCK_GAIN : 1;
    // Restart from the current gain if speech changes during a fade.
    if (target !== this.fadeTarget) {
      this.fadeFrom = this.gain;
      this.fadeTarget = target;
      this.fadePosition = 0;
    }
    // 60 ms smoothstep ease-in-out, shared by both stereo channels.
    for (let i = 0; i < FRAME_BYTES; i += 4) {
      if (this.fadePosition < FADE_SAMPLES) {
        const t = ++this.fadePosition / FADE_SAMPLES;
        const eased = t * t * (3 - 2 * t);
        this.gain = this.fadeFrom + (this.fadeTarget - this.fadeFrom) * eased;
      }
      for (let channel = 0; channel < 4; channel += 2) {
        const offset = i + channel;
        const a =
          speech && offset + 2 <= speech.length
            ? speech.readInt16LE(offset)
            : 0;
        const b =
          media && offset + 2 <= media.length ? media.readInt16LE(offset) : 0;
        output.writeInt16LE(
          Math.max(
            -32768,
            Math.min(32767, Math.round(a + b * MEDIA_GAIN * this.gain)),
          ),
          offset,
        );
      }
    }
    return output;
  }

  override _read(): void {
    if (this.timer || this.closedMixer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closedMixer) return;
      // Bound the complete encoding pipeline to 100 ms of prefetch. The
      // Discord transport clocks playback; a second 20 ms clock would drift.
      if (this.frame - this.acknowledged >= 5) this._read();
      else this.push(this.render());
    }, 5);
  }

  close(): void {
    if (this.closedMixer) return;
    this.closedMixer = true;
    clearTimeout(this.timer);
    for (const track of this.pending)
      track.finish(new Error("ミキサーを終了しました"));
    this.fences = [];
    this.destroy();
  }
}
