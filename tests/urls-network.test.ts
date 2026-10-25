import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ default: { get: mocks.get } }));
vi.mock("node:https", () => ({ default: { get: mocks.get } }));
import { describeUrl } from "../src/urls.js";
function response(
  status: number,
  headers: Record<string, string>,
  body: string,
  remote = "8.8.8.8",
) {
  const stream = Object.assign(new PassThrough(), {
    statusCode: status,
    headers,
    socket: { remoteAddress: remote },
  });
  queueMicrotask(() => stream.end(body));
  return stream;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
describe("URL接続境界", () => {
  it("検証済みIPをlookupに固定し、全アドレス形式にも対応", async () => {
    mocks.get.mockImplementation((_url, options, callback) => {
      const deliver = vi.fn();
      options.lookup("example.com", { all: true }, deliver);
      expect(deliver).toHaveBeenCalledWith(
        null,
        [{ address: "8.8.8.8", family: 4 }],
        4,
      );
      callback(
        response(
          200,
          { "content-type": "text/html" },
          '<meta property="og:site_name" content="サイト">',
        ),
      );
      return new EventEmitter();
    });
    expect(await describeUrl("https://example.com")).toBe("サイト");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("DNS応答に私有IPが混在しても拒否", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await describeUrl("https://example.com")).toBe(
      "リンクが送信されました",
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("公開URLからメタデータ宛へのリダイレクトを拒否", async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    mocks.get.mockImplementation((_url, _options, callback) => {
      callback(response(302, { location: "http://169.254.169.254/" }, ""));
      return new EventEmitter();
    });
    expect(await describeUrl("https://example.com")).toBe(
      "リンクが送信されました",
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it("接続先IPが異なる場合は拒否", async () => {
    mocks.get.mockImplementation((_url, _options, callback) => {
      callback(response(200, { "content-type": "text/html" }, "", "127.0.0.1"));
      return new EventEmitter();
    });
    expect(await describeUrl("https://example.com")).toBe(
      "リンクが送信されました",
    );
  });
  it("1MB超過はフォールバック", async () => {
    mocks.get.mockImplementation((_url, _options, callback) => {
      callback(
        response(
          200,
          { "content-type": "text/html" },
          "a".repeat(1024 * 1024 + 1),
        ),
      );
      return new EventEmitter();
    });
    expect(await describeUrl("https://example.com")).toBe(
      "リンクが送信されました",
    );
  });
  it("画像Content-Typeを識別", async () => {
    mocks.get.mockImplementation((_url, _options, callback) => {
      callback(response(200, { "content-type": "image/png" }, ""));
      return new EventEmitter();
    });
    expect(await describeUrl("https://example.com")).toBe(
      "画像が送信されました",
    );
  });
});
