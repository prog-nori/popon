import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProcessFailure } from "../audio/failure.js";

export function youtubeExecutable(): string {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  const relative =
    process.platform === "win32" ? "Scripts/yt-dlp.exe" : "bin/yt-dlp";
  const local = fileURLToPath(
    new URL(`../../.tools/media/${relative}`, import.meta.url),
  );
  return existsSync(local) ? local : "yt-dlp";
}

export class MediaError extends Error {}

// Only controlled messages go to Discord. Subprocess failures discard raw stderr.
export function mediaErrorMessage(error: unknown): string {
  if (error instanceof MediaError) return error.message;
  if (
    error instanceof ProcessFailure &&
    error.details.classification === "missing_executable"
  )
    return error.details.tool === "yt-dlp"
      ? "yt-dlpが見つかりません。Dockerイメージ内の実行ファイルとYT_DLP_PATHを確認してください。"
      : "音声処理に必要な外部コマンドが見つかりません。ffmpegの導入とFFMPEG_PATHを確認してください。";
  const failure = error as NodeJS.ErrnoException & { path?: string };
  if (failure?.code === "ENOENT") {
    if (failure.path?.includes("yt-dlp"))
      return "yt-dlpが見つかりません。Botの作業ディレクトリで npm run setup:media を実行して再起動してください。YT_DLP_PATHを指定している場合はそのパスも確認してください。";
    return "音声処理に必要な外部コマンドが見つかりません。ffmpegの導入とFFMPEG_PATHを確認してください。";
  }
  return "音声の取得またはデコードに失敗しました。表示された診断コードで取得環境と動画の利用可否を確認してください。";
}
