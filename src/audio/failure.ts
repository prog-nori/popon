export type MediaStage =
  "process" | "metadata" | "download" | "decode" | "playback";
export type FailureClass =
  | "missing_executable"
  | "permission_denied"
  | "http_403"
  | "http_429"
  | "dns"
  | "network"
  | "timeout"
  | "cancelled"
  | "provider_restriction"
  | "javascript_challenge"
  | "format_unavailable"
  | "invalid_media"
  | "invalid_metadata"
  | "metadata_too_large"
  | "unsupported_video"
  | "killed"
  | "process_exit"
  | "unknown";
export interface FailureDetails {
  stage: MediaStage;
  tool: "yt-dlp" | "ffmpeg" | "process";
  classification: FailureClass;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs?: number;
}

// Never store argv, executable paths, stderr, or the original error as a cause.
// Child stderr can contain cookies and signed media URLs.
export class ProcessFailure extends Error {
  constructor(readonly details: FailureDetails) {
    super(`音声処理に失敗: ${details.stage}/${details.classification}`);
    this.name = "ProcessFailure";
  }
}

export function classifyProcessFailure(stderr: string): FailureClass {
  if (
    /HTTP (?:Error |error |status(?: code)?[: ]*)?403|403 Forbidden/i.test(
      stderr,
    )
  )
    return "http_403";
  if (
    /HTTP (?:Error |error |status(?: code)?[: ]*)?429|429 Too Many/i.test(
      stderr,
    )
  )
    return "http_429";
  if (
    /not a bot|sign in to confirm|login required|private video|age.restricted|not available in your country|geo.restrict|members.only/i.test(
      stderr,
    )
  )
    return "provider_restriction";
  if (
    /getaddrinfo|name or service not known|temporary failure in name resolution|failed to resolve|could not resolve|nodename nor servname/i.test(
      stderr,
    )
  )
    return "dns";
  if (/timed? out|timeout/i.test(stderr)) return "timeout";
  if (
    /connection (?:refused|reset|aborted)|network is unreachable|unable to connect|certificate verify failed/i.test(
      stderr,
    )
  )
    return "network";
  if (
    /challenge solving failed|n challenge|nsig extraction failed|signature extraction failed|no supported javascript|javascript runtime|ejs.*(?:missing|unavailable|not found)/i.test(
      stderr,
    )
  )
    return "javascript_challenge";
  if (
    /requested format.*not available|no video formats|only images are available/i.test(
      stderr,
    )
  )
    return "format_unavailable";
  if (
    /invalid data found|error (?:while )?decoding|invalid input|could not find codec|error opening input|end of file/i.test(
      stderr,
    )
  )
    return "invalid_media";
  return "process_exit";
}

export function failureDetails(
  error: unknown,
  stage: MediaStage = "playback",
  signal?: AbortSignal,
): FailureDetails {
  if (error instanceof ProcessFailure) return { ...error.details };
  return {
    stage,
    tool: "process",
    exitCode: null,
    signal: null,
    classification:
      (error instanceof Error && error.name === "TimeoutError") ||
      (signal?.aborted &&
        signal.reason instanceof Error &&
        signal.reason.name === "TimeoutError")
        ? "timeout"
        : "unknown",
  };
}
