import { afterEach, expect, it, vi } from "vitest";
import { log } from "../src/log.js";
import { classifyProcessFailure } from "../src/audio/failure.js";
import {
  checkPoTokenProvider,
  poTokenArgs,
  poTokenObserver,
  poTokenOptions,
} from "../src/media/po-token.js";

vi.mock("../src/log.js", () => ({ log: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("defaults OFF and prevents installed plugins from silently enabling PO tokens", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const options = poTokenOptions({});
  expect(options.enabled).toBe(false);
  expect(poTokenArgs(options)).toEqual(["--no-plugin-dirs"]);
  await checkPoTokenProvider(options, new AbortController().signal);
  expect(fetch).not.toHaveBeenCalled();
});

it("uses mweb and HTTP only without cookies, proxy, trace, or a fixed token", () => {
  const args = poTokenArgs(
    poTokenOptions({
      YOUTUBE_POT_ENABLED: "true",
      YOUTUBE_POT_BASE_URL: "http://pot-provider:4416",
    }),
  );
  expect(args).toContain("youtube:player_client=mweb;fetch_pot=always");
  expect(args).toContain(
    "youtubepot-bgutilhttp:base_url=http://pot-provider:4416",
  );
  expect(args.join(" ")).not.toMatch(/pot_trace|po_token=|--cookies|--proxy/);
});

it.each([
  { YOUTUBE_POT_ENABLED: "invalid-secret" },
  {
    YOUTUBE_POT_ENABLED: "true",
    YOUTUBE_POT_BASE_URL: "http://secret:secret@localhost:4416",
  },
  {
    YOUTUBE_POT_ENABLED: "true",
    YOUTUBE_POT_BASE_URL: "http://localhost:4416/?token=secret",
  },
  { YOUTUBE_POT_ENABLED: "true", YOUTUBE_POT_BASE_URL: "file:///secret" },
  {
    YOUTUBE_POT_ENABLED: "true",
    YOUTUBE_POT_BASE_URL: "http://localhost:4416/path;secret",
  },
])("rejects invalid PO configuration without retaining its value", (env) => {
  let result: unknown;
  try {
    poTokenOptions(env);
  } catch (error) {
    result = error;
  }
  expect(result).toMatchObject({
    details: { classification: "pot_configuration" },
  });
  expect(JSON.stringify(result)).not.toContain("secret");
});

it("checks the non-secret /ping response and exact server/plugin version", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response('{"version":"2.0.2","server_uptime":1}'));
  vi.stubGlobal("fetch", fetch);
  await checkPoTokenProvider(
    { enabled: true, baseUrl: "http://pot-provider:4416" },
    new AbortController().signal,
  );
  expect(fetch).toHaveBeenCalledWith(
    "http://pot-provider:4416/ping",
    expect.objectContaining({ redirect: "error" }),
  );
  expect(log).toHaveBeenCalledWith("youtube_pot_provider", {
    reachable: true,
    version: "2.0.2",
  });
});

it.each(["unavailable", "mismatch", "oversized"])(
  "fails closed for a %s provider without leaking response/error data",
  async (kind) => {
    const fetch =
      kind === "unavailable"
        ? vi.fn().mockRejectedValue(new Error("token=secret"))
        : vi
            .fn()
            .mockResolvedValue(
              new Response(
                kind === "mismatch"
                  ? '{"version":"secret"}'
                  : "secret".repeat(1000),
              ),
            );
    vi.stubGlobal("fetch", fetch);
    const error = await checkPoTokenProvider(
      { enabled: true, baseUrl: "http://pot-provider:4416" },
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      details: {
        classification:
          kind === "mismatch"
            ? "pot_version_mismatch"
            : "pot_provider_unavailable",
      },
    });
    expect(JSON.stringify([error, vi.mocked(log).mock.calls])).not.toContain(
      "secret",
    );
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("observes requested/received GVS tokens and usage without returning raw logs", () => {
  const observer = poTokenObserver("download");
  observer.consume(
    "[debug] [youtube] [pot] PO Token Providers: bgutil:http-2.0.",
  );
  observer.consume(
    "2 (external)\n[youtube] [pot:bgutil:http] Generating a gvs PO Token for mweb client via bgutil HTTP server\n",
  );
  observer.consume(
    "[debug] [youtube] video: Retrieved a gvs PO Token for mweb client\n",
  );
  observer.consume(
    '[debug] Invoking http downloader on "https://media.invalid/?sig=secret&pot=secret"\nCookie: secret\n',
  );
  observer.finish(true);
  expect(() => observer.assertPlugin()).not.toThrow();
  expect(log).toHaveBeenLastCalledWith("youtube_pot_result", {
    stage: "download",
    ok: true,
    pluginRecognized: true,
    gvsTokenRequested: true,
    gvsTokenReceived: true,
    playerTokenRequested: false,
    playerTokenReceived: false,
    generationFailed: false,
    tokenOnGvsRequest: true,
  });
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("secret");
});

it("does not turn a generation attempt or plugin load into token/access success", () => {
  const observer = poTokenObserver("metadata");
  observer.consume(
    "[pot] PO Token Providers: bgutil:http-2.0.2 (external)\nGenerating a gvs PO Token for mweb client via bgutil HTTP server\nError fetching PO Token: token=secret",
  );
  observer.finish(false);
  expect(log).toHaveBeenLastCalledWith(
    "youtube_pot_result",
    expect.objectContaining({
      ok: false,
      gvsTokenRequested: true,
      gvsTokenReceived: false,
      generationFailed: true,
    }),
  );
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("secret");
});

it("observes Player token receipt separately from GVS tokens without exposing values", () => {
  const observer = poTokenObserver("metadata");
  observer.consume(
    "Generating a player PO Token for mweb client via bgutil HTTP server\nRetrieved a player PO Token for mweb client\nToken: secret\n",
  );
  observer.finish(true);
  expect(log).toHaveBeenLastCalledWith(
    "youtube_pot_result",
    expect.objectContaining({
      playerTokenRequested: true,
      playerTokenReceived: true,
      gvsTokenRequested: false,
      gvsTokenReceived: false,
    }),
  );
  expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("secret");
});

it("rejects a successful metadata process if the expected plugin was not recognized", () => {
  const observer = poTokenObserver("metadata");
  observer.consume("PO Token Providers: none\n");
  observer.finish(true);
  expect(() => observer.assertPlugin()).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({
        classification: "pot_plugin_missing",
      }),
    }),
  );
});

it("distinguishes login checks, GVS HTTP failures, and token generation failures", () => {
  expect(
    classifyProcessFailure(
      "HTTP Error 403: Sign in to confirm you're not a bot",
    ),
  ).toBe("provider_bot_check");
  expect(classifyProcessFailure("HTTP Error 403: Forbidden")).toBe("http_403");
  expect(
    classifyProcessFailure(
      'Error fetching PO Token from "bgutil:http": HTTP Error 403',
    ),
  ).toBe("pot_generation_failed");
});
