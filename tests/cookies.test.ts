import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const aws = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock("@aws-sdk/client-secrets-manager", async () => {
  const actual = await vi.importActual<
    typeof import("@aws-sdk/client-secrets-manager")
  >("@aws-sdk/client-secrets-manager");
  return {
    ...actual,
    SecretsManagerClient: vi.fn(function () {
      return { send: aws.send, destroy: aws.destroy };
    }),
  };
});
vi.mock("../src/log.js", () => ({ log: vi.fn() }));

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { log } from "../src/log.js";
import { classifyProcessFailure } from "../src/audio/failure.js";
import {
  YoutubeCookieStore,
  validateYoutubeCookies,
  youtubeCookieObserver,
  youtubeCookieOptions,
} from "../src/media/cookies.js";

// Deliberately fictitious data, never exported from a browser/account.
const MOCK =
  "# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tMOCK_AUTH\tMOCK_COOKIE_VALUE\n";
const options = {
  enabled: true,
  secretId: "/discord-bot/prod/youtube-cookies",
  region: "ap-northeast-1",
};
const stores: YoutubeCookieStore[] = [];
function store() {
  const result = new YoutubeCookieStore();
  stores.push(result);
  return result;
}
function signal() {
  return new AbortController().signal;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((item) => item.close()));
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(
    "MOCK_COOKIE_VALUE",
  );
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("defaults OFF without validating/using AWS settings", () => {
  expect(
    youtubeCookieOptions({ YOUTUBE_COOKIE_SECRET_ID: "secret-invalid\n" }),
  ).toEqual({ enabled: false, secretId: "", region: "" });
  expect(SecretsManagerClient).not.toHaveBeenCalled();
});

it("validates ON settings without including input values in errors", () => {
  expect(
    youtubeCookieOptions({
      YOUTUBE_COOKIES_ENABLED: "true",
      YOUTUBE_COOKIE_SECRET_ID: options.secretId,
      AWS_DEFAULT_REGION: options.region,
    }),
  ).toEqual(options);
  for (const env of [
    { YOUTUBE_COOKIES_ENABLED: "MOCK_COOKIE_VALUE" },
    { YOUTUBE_COOKIES_ENABLED: "true" },
    {
      YOUTUBE_COOKIES_ENABLED: "true",
      YOUTUBE_COOKIE_SECRET_ID: "MOCK_COOKIE_VALUE\n",
    },
  ]) {
    let error: unknown;
    try {
      youtubeCookieOptions(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      details: { classification: "cookie_configuration" },
    });
    expect(JSON.stringify(error)).not.toContain("MOCK_COOKIE_VALUE");
  }
});

it("validates Netscape/HttpOnly and normalizes CRLF without interpreting values", () => {
  expect(validateYoutubeCookies(MOCK.replace(/\n/g, "\r\n"))).toBe(MOCK);
  expect(validateYoutubeCookies(MOCK.trimEnd())).toBe(MOCK);
});

it.each([
  [undefined, "cookie_secret_not_string"],
  [" ", "cookie_empty"],
  ["# Netscape HTTP Cookie File\n", "cookie_empty"],
  ['{"MOCK_COOKIE_VALUE":"not-netscape"}', "cookie_format_invalid"],
  [MOCK.replace("\tTRUE\t/", "\tFALSE\t/"), "cookie_format_invalid"],
  [MOCK.replace("\t0\t", "\tinvalid\t"), "cookie_format_invalid"],
  [
    MOCK.replace("MOCK_COOKIE_VALUE", "invalid\tvalue"),
    "cookie_format_invalid",
  ],
  [
    MOCK.replace("MOCK_COOKIE_VALUE", "invalid\u0000value"),
    "cookie_format_invalid",
  ],
  [MOCK + "broken row", "cookie_format_invalid"],
  [MOCK + "#".repeat(65536), "cookie_format_invalid"],
])(
  "rejects empty/malformed contents without leaking values (%#)",
  (value, classification) => {
    let error: unknown;
    try {
      validateYoutubeCookies(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ details: { classification } });
    expect(JSON.stringify(error)).not.toContain("MOCK_COOKIE_VALUE");
  },
);

it("single-flights GetSecretValue and isolates concurrent writable jars with 0700/0600", async () => {
  aws.send.mockResolvedValue({ SecretString: MOCK });
  const cached = store();
  const [first, second] = await Promise.all([
    cached.acquire(options, signal()),
    cached.acquire(options, signal()),
  ]);
  expect(aws.send).toHaveBeenCalledOnce();
  expect(SecretsManagerClient).toHaveBeenCalledWith({
    region: options.region,
    maxAttempts: 2,
  });
  expect(aws.send.mock.calls[0]![0]).toBeInstanceOf(GetSecretValueCommand);
  expect(aws.send.mock.calls[0]![0].input).toEqual({
    SecretId: options.secretId,
  });
  expect(aws.send.mock.calls[0]![1].abortSignal).toBeInstanceOf(AbortSignal);
  expect(aws.destroy).toHaveBeenCalledOnce();
  expect(isAbsolute(first.path)).toBe(true);
  expect(first.path).not.toBe(second.path);
  expect((await stat(dirname(first.path))).mode & 0o777).toBe(0o700);
  expect((await stat(first.path)).mode & 0o777).toBe(0o600);
  expect(await readFile(first.path, "utf8")).toBe(MOCK);
  await writeFile(first.path, "simulated yt-dlp rewrite");
  expect(await readFile(second.path, "utf8")).toBe(MOCK);
  await Promise.all([first.release(), first.release(), second.release()]);
  await expect(stat(dirname(first.path))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(dirname(second.path))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const third = await cached.acquire(options, signal());
  expect(await readFile(third.path, "utf8")).toBe(MOCK);
  expect(aws.send).toHaveBeenCalledOnce();
});

it("does not remove a jar until yt-dlp has closed, even when release/close repeat", async () => {
  aws.send.mockResolvedValue({ SecretString: MOCK });
  const cached = store();
  const lease = await cached.acquire(options, signal());
  let finish!: () => void;
  lease.holdUntil(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const released = lease.release();
  await Promise.resolve();
  expect(await readFile(lease.path, "utf8")).toBe(MOCK);
  finish();
  await released;
  await cached.close();
  await expect(stat(lease.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  ["AccessDeniedException", "cookie_secret_access_denied"],
  ["ResourceNotFoundException", "cookie_secret_not_found"],
  ["DecryptionFailure", "cookie_secret_decryption"],
  ["CredentialsProviderError", "cookie_secret_credentials"],
  ["ThrottlingException", "cookie_secret_throttled"],
  ["AbortError", "cookie_secret_timeout"],
  ["NetworkingError", "cookie_secret_network"],
  ["InternalServiceError", "cookie_secret_unavailable"],
])(
  "classifies %s without retaining the SDK error or retrying per track",
  async (name, classification) => {
    aws.send.mockRejectedValue(
      Object.assign(new Error("MOCK_COOKIE_VALUE"), { name }),
    );
    const cached = store();
    for (let i = 0; i < 2; i++) {
      const error = await cached
        .acquire(options, signal())
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        details: { stage: "cookies", tool: "secrets-manager", classification },
      });
      expect(JSON.stringify(error)).not.toContain("MOCK_COOKIE_VALUE");
      expect(String(error)).not.toContain("MOCK_COOKIE_VALUE");
    }
    expect(aws.send).toHaveBeenCalledOnce();
  },
);

it("reports successful AWS retrieval separately from invalid cookie contents", async () => {
  aws.send.mockResolvedValue({ SecretString: "MOCK_COOKIE_VALUE" });
  await expect(store().acquire(options, signal())).rejects.toMatchObject({
    details: { classification: "cookie_format_invalid" },
  });
  expect(log).toHaveBeenCalledWith("youtube_cookie_secret_fetch", { ok: true });
  expect(log).toHaveBeenCalledWith("youtube_cookie_file_ready", {
    ok: false,
    classification: "cookie_format_invalid",
  });
});

it.each([
  ["ENOTFOUND", "cookie_secret_network"],
  ["ETIMEDOUT", "cookie_secret_timeout"],
])("classifies SDK transport code %s safely", async (code, classification) => {
  aws.send.mockRejectedValue(
    Object.assign(new Error("MOCK_COOKIE_VALUE"), { code }),
  );
  const error = await store()
    .acquire(options, signal())
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({ details: { classification } });
  expect(JSON.stringify(error)).not.toContain("MOCK_COOKIE_VALUE");
});

it("fetches the updated secret in a new store/task, keeping the old task snapshot", async () => {
  const newer = MOCK.replace("MOCK_COOKIE_VALUE", "MOCK_NEW_VALUE");
  aws.send
    .mockResolvedValueOnce({ SecretString: MOCK })
    .mockResolvedValueOnce({ SecretString: newer });
  const old = store();
  const first = await old.acquire(options, signal());
  const nextTask = await store().acquire(options, signal());
  expect(await readFile(first.path, "utf8")).toBe(MOCK);
  expect(await readFile(nextTask.path, "utf8")).toBe(newer);
  expect(aws.send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(
    "MOCK_NEW_VALUE",
  );
});

it("cancels without fetching or producing a jar and refuses use after shutdown", async () => {
  const cached = store();
  const controller = new AbortController();
  controller.abort();
  await expect(
    cached.acquire(options, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(aws.send).not.toHaveBeenCalled();
  await cached.close();
  await expect(cached.acquire(options, signal())).rejects.toMatchObject({
    details: { classification: "cookie_store_closed" },
  });
});

it("cancels one pending playback promptly without cancelling a shared fetch", async () => {
  let finish!: (value: { SecretString: string }) => void;
  aws.send.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const cached = store();
  const controller = new AbortController();
  const cancelled = cached.acquire(options, controller.signal);
  const another = cached.acquire(options, signal());
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(aws.send.mock.calls[0]![1].abortSignal.aborted).toBe(false);
  finish({ SecretString: MOCK });
  const ready = await another;
  expect(await readFile(ready.path, "utf8")).toBe(MOCK);
  expect(aws.send).toHaveBeenCalledOnce();
});

it("aborts the pending SDK request on store shutdown and creates no file", async () => {
  aws.send.mockImplementation(
    (_command, { abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("MOCK_COOKIE_VALUE"), {
                name: "AbortError",
              }),
            ),
          { once: true },
        );
      }),
  );
  const cached = store();
  const pending = cached.acquire(options, signal());
  const outcome = expect(pending).rejects.toMatchObject({
    details: { classification: "cancelled" },
  });
  await cached.close();
  await outcome;
  expect(log).not.toHaveBeenCalledWith(
    "youtube_cookie_file_ready",
    expect.objectContaining({ ok: true }),
  );
});

it("refuses temporary files in the working tree", async () => {
  aws.send.mockResolvedValue({ SecretString: MOCK });
  vi.stubEnv("TMPDIR", process.cwd());
  await expect(store().acquire(options, signal())).rejects.toMatchObject({
    details: { classification: "cookie_file_io" },
  });
});

it("sanitizes filesystem failures without passing native error messages", async () => {
  aws.send.mockResolvedValue({ SecretString: MOCK });
  vi.stubEnv("TMPDIR", join(tmpdir(), `not-created-${randomUUID()}`));
  await expect(store().acquire(options, signal())).rejects.toMatchObject({
    details: { classification: "cookie_file_io" },
  });
});

it("distinguishes cookie detection from server acceptance and observes LOGIN_REQUIRED safely", () => {
  const observation = youtubeCookieObserver("metadata");
  observation.consume("[debug] Found YouTube account cook");
  observation.consume(
    "ies\n[debug] mweb player response playability status: LOGIN_REQUIRED\nAuthorization: MOCK_COOKIE_VALUE\n",
  );
  observation.finish("failed", "youtube_login_required");
  expect(log).toHaveBeenLastCalledWith(
    "youtube_cookie_auth_result",
    expect.objectContaining({
      cookieRead: "observed",
      accountCookiesDetected: true,
      loginRequiredObserved: true,
      loginAcceptance: "rejected",
      outcome: "login_required",
    }),
  );
});

it("never treats public metadata success as proof that YouTube accepted login", () => {
  const observation = youtubeCookieObserver("metadata");
  observation.consume("[youtube] video: Downloading mweb player API JSON\n");
  observation.finish("metadata_ok");
  expect(log).toHaveBeenLastCalledWith(
    "youtube_cookie_auth_result",
    expect.objectContaining({
      cookieRead: "observed",
      accountCookiesDetected: false,
      loginAcceptance: "unverified",
      outcome: "metadata_ok",
    }),
  );
});

it("reports cookie load failures and stream HTTP 403 separately", () => {
  const observation = youtubeCookieObserver("metadata");
  observation.consume("failed to load cookies: MOCK_COOKIE_VALUE");
  observation.finish("failed", "cookie_load_failed");
  expect(log).toHaveBeenLastCalledWith(
    "youtube_cookie_auth_result",
    expect.objectContaining({ cookieRead: "failed" }),
  );
  expect(classifyProcessFailure("LOGIN_REQUIRED")).toBe(
    "youtube_login_required",
  );
  expect(classifyProcessFailure("failed to load cookies")).toBe(
    "cookie_load_failed",
  );
  expect(classifyProcessFailure("HTTP Error 403: Forbidden")).toBe("http_403");
});
