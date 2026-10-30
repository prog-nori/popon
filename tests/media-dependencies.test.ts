import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
import { existsSync } from "node:fs";
import {
  youtubeExecutable,
  mediaErrorMessage,
  MediaError,
} from "../src/media/dependencies.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("prefers an explicit executable over the local installation", () => {
  vi.stubEnv("YT_DLP_PATH", "/custom/yt-dlp");
  vi.mocked(existsSync).mockReturnValue(true);
  expect(youtubeExecutable()).toBe("/custom/yt-dlp");
});
it("finds the repository installation independently of the shell PATH", () => {
  vi.stubEnv("YT_DLP_PATH", "");
  vi.mocked(existsSync).mockReturnValue(true);
  expect(youtubeExecutable()).toMatch(
    /\.tools\/media\/(bin\/yt-dlp|Scripts\/yt-dlp.exe)$/,
  );
});
it("preserves PATH-based installations when no local installation exists", () => {
  vi.stubEnv("YT_DLP_PATH", "");
  vi.mocked(existsSync).mockReturnValue(false);
  expect(youtubeExecutable()).toBe("yt-dlp");
});
it("distinguishes missing tools from unsupported videos without exposing stderr", () => {
  expect(
    mediaErrorMessage(
      Object.assign(new Error("spawn yt-dlp ENOENT"), {
        code: "ENOENT",
        path: "yt-dlp",
      }),
    ),
  ).toContain("npm run setup:media");
  expect(
    mediaErrorMessage(
      Object.assign(new Error("spawn ffmpeg ENOENT"), {
        code: "ENOENT",
        path: "ffmpeg",
      }),
    ),
  ).toContain("FFMPEG_PATH");
  expect(mediaErrorMessage(new MediaError("ライブは対象外です"))).toBe(
    "ライブは対象外です",
  );
  expect(mediaErrorMessage(new Error("sensitive stderr"))).not.toContain(
    "sensitive",
  );
});
