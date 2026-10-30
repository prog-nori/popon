import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { AudioOutput } from "../src/audio.js";
import {
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";

function peakOf(packets: Buffer[]): number {
  const Opus = createRequire(import.meta.url)("opusscript") as new (
    rate: number,
    channels: number,
    application: number,
  ) => { decode(packet: Buffer): Buffer; delete(): void };
  const decoder = new Opus(48000, 2, 2049);
  let peak = 0;
  try {
    for (const packet of packets) {
      const pcm = decoder.decode(packet);
      for (let i = 0; i < pcm.length; i += 2)
        peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    }
  } finally {
    decoder.delete();
  }

  return peak;
}

// Use the real AudioPlayer and encoder, replacing only the network connection.
function transport() {
  let prepared: Buffer | undefined;
  const packets: Buffer[] = [];
  const connection = {
    state: { status: VoiceConnectionStatus.Connecting },
    subscribe(player: AudioPlayer) {
      return (
        player as unknown as { subscribe(connection: unknown): unknown }
      ).subscribe(connection);
    },
    prepareAudioPacket(packet: Buffer) {
      prepared = Buffer.from(packet);
    },
    dispatchAudio() {
      if (prepared) packets.push(prepared);
      prepared = undefined;
    },
    setSpeaking() {},
    onSubscriptionRemoved() {},
  };
  return {
    connection: connection as unknown as VoiceConnection,
    packets,
    ready() {
      connection.state.status = VoiceConnectionStatus.Ready;
    },
  };
}
const available =
  spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0;
it.skipIf(!available)(
  "sends audible Opus after connection readiness using the real AudioPlayer",
  async () => {
    const fake = transport();
    const errors = vi.fn();
    const output = new AudioOutput(fake.connection, errors);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(6000),
    ]);
    const start = vi.fn();
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.packets).toHaveLength(0);
      fake.ready();
      await output.play("assets/sounds/meet_style.wav", signal, start);
      expect(start).toHaveBeenCalledOnce();
      expect(errors).not.toHaveBeenCalled();
      expect(peakOf(fake.packets)).toBeGreaterThan(500);
    } finally {
      controller.abort();
      output.stop();
    }
  },
  10000,
);

it("does not transmit placeholder silence while waiting for TTS preparation", async () => {
  const fake = transport();
  fake.ready();
  const output = new AudioOutput(fake.connection);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.packets).toHaveLength(0);
  } finally {
    output.stop();
  }
});

it.skipIf(!available)(
  "plays queued decoded tracks and a later addition through one player",
  async () => {
    const { MediaQueue } = await import("../src/media/queue.js");
    const { decode } = await import("../src/audio/process.js");
    const fake = transport();
    fake.ready();
    const errors = vi.fn();
    const output = new AudioOutput(fake.connection, errors);
    const opened: string[] = [],
      ended: string[] = [];
    let active = "";
    const peaks: number[] = [];
    const queue = new MediaQueue(
      {
        async open(url, signal) {
          opened.push(url);
          active = url;
          return decode("assets/sounds/meet_style.wav", signal);
        },
      },
      async (stream, signal) => {
        const firstPacket = fake.packets.length;
        await output.playMedia(stream, signal);
        peaks.push(peakOf(fake.packets.slice(firstPacket)));
        ended.push(active);
      },
    );
    const notify = vi.fn(async () => {});
    try {
      queue.push("first", notify);
      queue.push("second", notify);
      queue.start();
      await vi.waitFor(() => expect(ended).toEqual(["first", "second"]), {
        timeout: 5000,
      });
      queue.push("third", notify);
      await vi.waitFor(
        () => expect(ended).toEqual(["first", "second", "third"]),
        { timeout: 3000 },
      );
      expect(opened).toEqual(ended);
      expect(peaks).toHaveLength(3);
      expect(peaks.every((peak) => peak > 500)).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      queue.close();
      output.stop();
    }
  },
  10000,
);
