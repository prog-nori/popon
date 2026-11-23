/** Container entry point: importing configuration may itself fail. */
import { startupFailureCode } from "./startup.js";

try {
  await import("./index.js");
  if (process.exitCode) throw new Error("bot_startup_failed");
} catch (error) {
  console.error(
    JSON.stringify({
      event: "bot_startup_failed",
      code: startupFailureCode(error),
    }),
  );
  // Explicit opt-in for a single-task service. Never silently change scaling.
  if (process.env.ECS_STOP_ON_FATAL === "true") {
    try {
      const { serviceScaler } = await import("./aws-service.js");
      await serviceScaler(
        process.env.AWS_REGION ??
          process.env.AWS_DEFAULT_REGION ??
          "ap-northeast-1",
        process.env.ECS_CLUSTER ?? "",
        process.env.ECS_SERVICE ?? "",
      )(0);
    } catch {
      console.error(JSON.stringify({ event: "fatal_service_stop_failed" }));
    }
  }
  process.exitCode = 1;
}
