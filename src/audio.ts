import { Readable } from "node:stream";
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  type VoiceConnection,
} from "@discordjs/voice";
export class AudioOutput {
  readonly player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
  });
  constructor(connection: VoiceConnection) {
    connection.subscribe(this.player);
  }
  play(
    input: Buffer | string,
    signal: AbortSignal,
    onStart?: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.player.off("error", fail);
        this.player.off(AudioPlayerStatus.Idle, done);
        this.player.off(AudioPlayerStatus.Playing, started);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = (e: Error) => {
        cleanup();
        this.player.stop(true);
        reject(e);
      };
      const abort = () => fail(new Error("再生をキャンセルしました"));
      const started = () => onStart?.();
      const timer = setTimeout(
        () => fail(new Error("再生タイムアウト")),
        60000,
      );
      this.player.once("error", fail);
      this.player.once(AudioPlayerStatus.Idle, done);
      this.player.once(AudioPlayerStatus.Playing, started);
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.player.play(
          createAudioResource(
            typeof input === "string" ? input : Readable.from(input),
          ),
        );
      } catch (e) {
        fail(e as Error);
      }
    });
  }
  stop(): void {
    this.player.stop(true);
  }
}
