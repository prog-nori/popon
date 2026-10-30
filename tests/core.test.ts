import { describe, it, expect, vi } from "vitest";
import { SpeechQueue, type SpeechJob } from "../src/queue.js";
import { TTSLifecycleManager, type TTSProvider } from "../src/tts.js";
import { normalize, speechText } from "../src/text.js";
import {
  publicAddress,
  validateUrl,
  siteName,
  describeUrl,
} from "../src/urls.js";
const job = (id: string): SpeechJob => ({
  id,
  name: "きし",
  content: "やあ",
  attachments: [],
  receivedAt: Date.now(),
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
describe("読み上げ", () => {
  it("サーバー表示名を先頭に付ける", async () =>
    expect(await speechText("きし", "やあ", [], {})).toBe("きし やあ"));
  it("辞書・Discord記法を整形する", () =>
    expect(normalize("**ぽぽん** <:smile:123> www", { ぽぽん: "ポポン" })).toBe(
      "ポポン smile 笑い",
    ));
  it("添付画像を読み上げる", async () =>
    expect(await speechText("きし", "", ["image/png"], {})).toBe(
      "きし 画像が送信されました",
    ));
  it("本文は200文字で制限する", async () =>
    expect((await speechText("A", "あ".repeat(300), [], {})).length).toBe(202));
});
describe("URL安全性", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "224.0.0.1",
  ])("%s を拒否", (ip) => expect(publicAddress(ip)).toBe(false));
  it("公開IPを許可", () => expect(publicAddress("8.8.8.8")).toBe(true));
  it.each([
    "file:///etc/passwd",
    "http://user:pass@example.com",
    "http://example.com:22",
  ])("危険URL %s を拒否", (url) => expect(() => validateUrl(url)).toThrow());
  it("私有IPへの取得はフォールバック", async () =>
    expect(await describeUrl("http://127.0.0.1")).toBe(
      "リンクが送信されました",
    ));
  it("OGサイト名を優先", () =>
    expect(
      siteName(
        '<meta property="og:site_name" content="テスト">',
        "example.com",
      ),
    ).toBe("テスト"));
  it("タイトルを区切り文字で推測しない", () =>
    expect(siteName("<title>商品 | 不明</title>", "example.com")).toBe(
      "リンクが送信されました",
    ));
  it("既知サイトを識別", () =>
    expect(
      siteName("<title>AIRMAX | NIKEオンラインストア</title>", "www.nike.com"),
    ).toBe("NIKEオンラインストア"));
});
describe("キュー", () => {
  it("準備中保持、FIFO、重複抑止、失敗後継続", async () => {
    const order: string[] = [];
    const queue = new SpeechQueue(async (j) => {
      order.push(j.id);
      if (j.id === "1") throw new Error("合成失敗");
    });
    expect(queue.push(job("1"))).toBe("accepted");
    expect(queue.push(job("1"))).toBe("duplicate");
    queue.push(job("2"));
    expect(order).toEqual([]);
    queue.start();
    await tick();
    expect(order).toEqual(["1", "2"]);
  });
  it("上限20件と退出時の破棄", () => {
    const queue = new SpeechQueue(async () => {});
    for (let i = 0; i < 20; i++)
      expect(queue.push(job(String(i)))).toBe("accepted");
    expect(queue.push(job("21"))).toBe("full");
    queue.close();
    expect(queue.push(job("22"))).toBe("closed");
  });
  it("同時再生せず退出で実行中処理を中止", async () => {
    let active = 0;
    let peak = 0;
    let aborted = false;
    const queue = new SpeechQueue(async (_j, signal) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      active--;
    });
    queue.push(job("1"));
    queue.push(job("2"));
    queue.start();
    queue.start();
    queue.close();
    await tick();
    expect(peak).toBe(1);
    expect(aborted).toBe(true);
  });
});
describe("TTSライフサイクル", () => {
  it("同時joinは一度だけ起動、ウォームアップ後READY", async () => {
    const provider = { synthesize: vi.fn(async () => Buffer.from("wav")) };
    const engine = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const life = new TTSLifecycleManager(provider, engine, 20, 1000);
    await Promise.all([life.acquire("a"), life.acquire("b")]);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
    expect(life.state).toBe("READY");
    life.release("a");
    await tick();
    expect(engine.stop).not.toHaveBeenCalled();
    life.release("b");
    await new Promise((r) => setTimeout(r, 40));
    expect(life.state).toBe("STOPPED");
  });
  it("猶予中の再joinで再利用", async () => {
    const engine = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const life = new TTSLifecycleManager(
      { synthesize: async () => Buffer.from("wav") },
      engine,
      20,
      1000,
    );
    await life.acquire("a");
    life.release("a");
    await life.acquire("a");
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.stop).not.toHaveBeenCalled();
    life.release("a");
    await life.stop();
  });
  it("起動失敗から次のjoinで回復", async () => {
    const engine = {
      start: vi
        .fn()
        .mockRejectedValueOnce(new Error("failed"))
        .mockResolvedValue(undefined),
      stop: vi.fn(async () => {}),
    };
    const life = new TTSLifecycleManager(
      { synthesize: async () => Buffer.from("wav") },
      engine,
      20,
      1000,
    );
    await expect(life.acquire("a")).rejects.toThrow();
    expect(life.state).toBe("ERROR");
    life.release("a");
    await life.acquire("a");
    expect(life.state).toBe("READY");
    life.release("a");
    await life.stop();
  });
  it("HTTP準備だけではREADYにならない", async () => {
    let finish!: (value: Buffer) => void;
    const provider: TTSProvider = {
      synthesize: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const life = new TTSLifecycleManager(
      provider,
      { async start() {}, async stop() {} },
      20,
      1000,
    );
    const ready = life.acquire("a");
    await tick();
    expect(life.state).toBe("WARMING");
    finish(Buffer.from("wav"));
    await ready;
    expect(life.state).toBe("READY");
    life.release("a");
    await life.stop();
  });
});

describe("準備中の退出", () => {
  it("cancels warmup only after the last guild leaves and permits immediate retry", async () => {
    let signal: AbortSignal | undefined;
    const provider = {
      synthesize: vi.fn((_text: string, value?: AbortSignal) => {
        signal = value;
        return new Promise<Buffer>(() => {});
      }),
    };
    const engine = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const life = new TTSLifecycleManager(provider, engine, 1000, 180000);
    const a = life.acquire("a");
    const b = life.acquire("b");
    const result = Promise.allSettled([a, b]);
    await tick();
    life.release("a");
    expect(signal?.aborted).toBe(false);
    life.release("b");
    expect(signal?.aborted).toBe(true);
    provider.synthesize.mockResolvedValue(Buffer.from("wav"));
    await life.acquire("c");
    expect((await result).every((r) => r.status === "rejected")).toBe(true);
    expect(life.state).toBe("READY");
    life.release("c");
    await life.stop();
  });
});
