import { afterEach, describe, expect, it, vi } from "vitest";
import { VoicevoxProvider, ProcessEngine } from "../src/tts.js";
afterEach(() => vi.unstubAllGlobals());
describe("VOICEVOX API", () => {
  it("audio_queryからsynthesisへ話者・話速・音量を渡す", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accent_phrases: [] })),
      )
      .mockResolvedValueOnce(new Response("RIFFfakeWAV"));
    vi.stubGlobal("fetch", fetch);
    const provider = new VoicevoxProvider(
      "http://localhost:50021",
      3,
      1.2,
      0.8,
    );
    expect((await provider.synthesize("表示名 やあ")).toString()).toBe(
      "RIFFfakeWAV",
    );
    expect(fetch.mock.calls[0][0]).toContain("speaker=3");
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.speedScale).toBe(1.2);
    expect(body.volumeScale).toBe(0.8);
  });
  it("HTTPエラーを伝播", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );
    await expect(
      new VoicevoxProvider("http://localhost:50021", 3).synthesize("やあ"),
    ).rejects.toThrow("audio_query: 500");
  });
  it("存在しないEngineは再試行しても正常起動扱いにしない", async () => {
    const engine = new ProcessEngine("/nonexistent/popon-voicevox", []);
    await expect(engine.start()).rejects.toThrow();
    await expect(engine.start()).rejects.toThrow();
    await engine.stop();
  });
});
