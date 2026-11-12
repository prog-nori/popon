import { describe, expect, it, vi } from "vitest";
import {
  loginFailureMessage,
  loginOrShutdown,
  startupFailureCode,
} from "../src/startup.js";

describe("Discord起動失敗", () => {
  it("未許可Intentの設定場所を案内し、起動済みリソースを閉じる", async () => {
    const shutdown = vi.fn(async () => {});
    const report = vi.fn();
    const result = await loginOrShutdown(
      async () => {
        throw new Error("Used disallowed intents");
      },
      shutdown,
      report,
    );
    expect(result).toBe(false);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining("Message Content IntentをON"),
    );
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining("Save Changes"),
    );
  });

  it("成功時には終了しない", async () => {
    const shutdown = vi.fn(async () => {});
    const report = vi.fn();
    expect(await loginOrShutdown(async () => {}, shutdown, report)).toBe(true);
    expect(shutdown).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("未知の例外の内容をそのまま表示しない", () => {
    expect(loginFailureMessage(new Error("secret-placeholder"))).not.toContain(
      "secret-placeholder",
    );
  });

  it.each([
    [
      new Error("DISCORD_TOKEN が環境変数に設定されていません"),
      "DISCORD_TOKEN_MISSING",
    ],
    [
      Object.assign(new Error("sensitive-placeholder"), {
        code: "TokenInvalid",
      }),
      "DISCORD_TOKEN_INVALID",
    ],
    [
      new Error("fetch failed", {
        cause: Object.assign(new Error("sensitive-placeholder"), {
          code: "ENOTFOUND",
        }),
      }),
      "STARTUP_DNS_FAILED",
    ],
    [
      Object.assign(new Error("private/path"), { code: "ENOENT" }),
      "STARTUP_FILE_MISSING",
    ],
    [new Error("COMMAND_TTL_MS の値が不正です"), "CONFIG_INVALID_NUMBER"],
    [new SyntaxError("sensitive-placeholder"), "STARTUP_PARSE_FAILED"],
    [
      Object.assign(new Error("sensitive-placeholder"), {
        code: "sensitive-code",
      }),
      "STARTUP_FAILURE_UNCLASSIFIED",
    ],
  ])("returns a fixed, secret-free diagnostic code", (error, expected) => {
    expect(startupFailureCode(error)).toBe(expected);
    expect(loginFailureMessage(error)).not.toContain("sensitive-placeholder");
  });
});
