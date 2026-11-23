import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ factory: vi.fn(), scale: vi.fn() }));
vi.mock("../src/index.js", () => {
  throw new Error("sensitive-placeholder");
});
vi.mock("../src/aws-service.js", () => ({
  serviceScaler: (...args: unknown[]) => {
    state.factory(...args);
    return state.scale;
  },
}));
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.resetModules();
  vi.clearAllMocks();
  state.scale.mockReset();
  state.scale.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("ECS_STOP_ON_FATAL", "false");
  vi.stubEnv("AWS_REGION", undefined);
  vi.stubEnv("AWS_DEFAULT_REGION", "ap-northeast-1");
  vi.stubEnv("ECS_CLUSTER", "discord-bot-cluster");
  vi.stubEnv("ECS_SERVICE", "discord-bot-service");
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("does not modify ECS on startup failure without explicit opt-in or leak the exception", async () => {
  await import("../src/main.js");
  expect(process.exitCode).toBe(1);
  expect(state.factory).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    "sensitive-placeholder",
  );
});
it("requests desiredCount=0 for the configured service only when opted in", async () => {
  vi.stubEnv("ECS_STOP_ON_FATAL", "true");
  await import("../src/main.js");
  expect(state.factory).toHaveBeenCalledExactlyOnceWith(
    "ap-northeast-1",
    "discord-bot-cluster",
    "discord-bot-service",
  );
  expect(state.scale).toHaveBeenCalledExactlyOnceWith(0);
  expect(process.exitCode).toBe(1);
});
it("handles a failed ECS stop request without an unhandled rejection", async () => {
  vi.stubEnv("ECS_STOP_ON_FATAL", "true");
  state.scale.mockRejectedValue(new Error("denied"));
  await import("../src/main.js");
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(
    JSON.stringify({ event: "fatal_service_stop_failed" }),
  );
});
