import {
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  AudioPlayerStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { Mixer } from "./audio/mixer.js";
import { decode } from "./audio/process.js";
import type { Readable } from "node:stream";

export class AudioOutput {
  readonly player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  readonly mixer = new Mixer();
  private resource = createAudioResource(this.mixer, {
    inputType: StreamType.Raw,
  });
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private stopped = false;
  constructor(
    connection: VoiceConnection,
    onError: (error: Error) => void = () => {},
  ) {
    connection.subscribe(this.player);
    this.player.on("error", onError);
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (!this.stopped) onError(new Error("共有音声出力が停止しました"));
    });
  }
  private start(): void {
    if (this.stopped) throw new Error("音声出力は終了しています");
    if (this.started) return;
    this.started = true;
    this.player.play(this.resource);
    this.timer = setInterval(
      () =>
        this.mixer.acknowledge(
          Math.max(0, Math.floor(this.resource.playbackDuration / 20) - 1),
        ),
      20,
    );
  }
  async play(
    input: Buffer | string,
    signal: AbortSignal,
    onStart?: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    this.start();
    const controller = new AbortController();
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(60000),
    ]);
    const decoded = decode(input, combined);
    try {
      await Promise.all([
        this.mixer.play("speech", decoded.stream, combined, onStart),
        decoded.done,
      ]);
    } finally {
      controller.abort();
      decoded.stop();
    }
  }
  playMedia(
    stream: Readable,
    signal: AbortSignal,
    onStart?: () => void,
  ): Promise<void> {
    try {
      signal.throwIfAborted();
      this.start();
      return this.mixer.play("media", stream, signal, onStart);
    } catch (error) {
      stream.destroy();
      return Promise.reject(error);
    }
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.mixer.close();
    this.player.stop(true);
    this.resource.playStream.destroy();
  }
}
