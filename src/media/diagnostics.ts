import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { youtubeExecutable } from "./dependencies.js";

function read(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
function numeric(value: string): number | null {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
}
export function mediaResources() {
  const events = read("/sys/fs/cgroup/memory.events");
  return {
    nodeRssBytes: process.memoryUsage().rss,
    memoryCurrentBytes: numeric(
      read("/sys/fs/cgroup/memory.current") ||
        read("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    ),
    memoryPeakBytes: numeric(
      read("/sys/fs/cgroup/memory.peak") ||
        read("/sys/fs/cgroup/memory/memory.max_usage_in_bytes"),
    ),
    memoryLimitBytes: numeric(
      read("/sys/fs/cgroup/memory.max") ||
        read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    ),
    oomKills: numeric(/^oom_kill (\d+)$/m.exec(events)?.[1] || ""),
    cpuThrottledUsec: numeric(
      /^throttled_usec (\d+)$/m.exec(read("/sys/fs/cgroup/cpu.stat"))?.[1] ||
        "",
    ),
  };
}

// Extract version tokens only. Never forward the subprocess output/error.
function version(executable: string, args: string[], pattern: RegExp) {
  try {
    const output = execFileSync(executable, args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 131072,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { available: true, version: pattern.exec(output)?.[1] ?? null };
  } catch {
    return { available: false, version: null };
  }
}
export function mediaTools() {
  return {
    node: process.version,
    ytDlp: version(
      youtubeExecutable(),
      ["--version"],
      /^(\d{4}\.\d{2}\.\d{2})/,
    ),
    ffmpeg: version(
      process.env.FFMPEG_PATH || "ffmpeg",
      ["-version"],
      /^ffmpeg version ([\w.+~-]+)/,
    ),
    ejs: version(
      "/opt/media/bin/python",
      [
        "-c",
        'import importlib.metadata; print(importlib.metadata.version("yt-dlp-ejs"))',
      ],
      /^([\d.]+)/,
    ),
    jsRuntime: "node",
  };
}
