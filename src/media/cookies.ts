import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { ProcessFailure, type FailureClass } from "../audio/failure.js";
import { log } from "../log.js";
import { waitWithAbort } from "../readiness.js";

export interface YoutubeCookieOptions {
  enabled: boolean;
  secretId: string;
  region: string;
}

function failure(classification: FailureClass, secret = false) {
  return new ProcessFailure({
    stage: "cookies",
    tool: secret ? "secrets-manager" : "process",
    classification,
    exitCode: null,
    signal: null,
  });
}

// Independent of Discord config: the media diagnostic can run without a Bot token.
export function youtubeCookieOptions(env = process.env): YoutubeCookieOptions {
  const flag = env.YOUTUBE_COOKIES_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false")
    throw failure("cookie_configuration");
  if (flag === "false") return { enabled: false, secretId: "", region: "" };
  const secretId = env.YOUTUBE_COOKIE_SECRET_ID ?? "";
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "ap-northeast-1";
  if (
    !secretId ||
    secretId.length > 2048 ||
    !/^[A-Za-z0-9/:_+=.@-]+$/.test(secretId) ||
    !/^[a-z0-9-]+$/.test(region)
  )
    throw failure("cookie_configuration");
  return { enabled: true, secretId, region };
}

export function validateYoutubeCookies(value: unknown): string {
  if (typeof value !== "string")
    throw failure("cookie_secret_not_string", true);
  if (!value.trim()) throw failure("cookie_empty");
  if (Buffer.byteLength(value, "utf8") > 65536)
    throw failure("cookie_format_invalid");
  const text = value.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (!/^# (?:Netscape )?HTTP Cookie File(?:\s|$)/.test(lines[0] ?? ""))
    throw failure("cookie_format_invalid");
  let entries = 0;
  for (const source of lines) {
    const line = source.startsWith("#HttpOnly_") ? source.slice(10) : source;
    if (line.startsWith("#") || !line.trim()) continue;
    // Reject invalid rows rather than letting yt-dlp warn with a secret row.
    if (
      [...line].some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && code !== 9) || code === 127;
      })
    )
      throw failure("cookie_format_invalid");
    const fields = line.split("\t");
    if (fields.length !== 7) throw failure("cookie_format_invalid");
    const [domain, subdomains, path, secure, expires, name, content] =
      fields as [string, string, string, string, string, string, string];
    if (
      !/^\.?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(domain) ||
      !["TRUE", "FALSE"].includes(subdomains) ||
      domain.startsWith(".") !== (subdomains === "TRUE") ||
      !path.startsWith("/") ||
      !["TRUE", "FALSE"].includes(secure) ||
      (expires !== "" && !/^\d+$/.test(expires)) ||
      (expires !== "" && !Number.isSafeInteger(Number(expires))) ||
      !name ||
      /[\s=;]/.test(name)
    )
      throw failure("cookie_format_invalid");
    if (content) entries++;
  }
  if (!entries) throw failure("cookie_empty");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function secretFailure(error: unknown): FailureClass {
  const name =
    error && typeof error === "object" && "name" in error ? error.name : "";
  const code =
    error && typeof error === "object" && "code" in error ? error.code : "";
  if (name === "AccessDeniedException" || name === "AccessDenied")
    return "cookie_secret_access_denied";
  if (name === "ResourceNotFoundException") return "cookie_secret_not_found";
  if (name === "DecryptionFailure") return "cookie_secret_decryption";
  if (
    name === "CredentialsProviderError" ||
    name === "ExpiredTokenException" ||
    name === "UnrecognizedClientException"
  )
    return "cookie_secret_credentials";
  if (name === "ThrottlingException" || name === "TooManyRequestsException")
    return "cookie_secret_throttled";
  if (name === "AbortError" || name === "TimeoutError")
    return "cookie_secret_timeout";
  if (code === "ETIMEDOUT") return "cookie_secret_timeout";
  if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ].includes(code as string)
  )
    return "cookie_secret_network";
  if (name === "NetworkingError" || name === "RequestTimeout")
    return "cookie_secret_network";
  return "cookie_secret_unavailable";
}

export interface YoutubeCookieLease {
  readonly path: string;
  holdUntil(done: Promise<unknown>): void;
  release(): Promise<void>;
}

export class YoutubeCookieStore {
  // Both success and failure are shared: no per-track retry storm after IAM/network errors.
  private snapshots = new Map<string, Promise<string>>();
  private leases = new Set<YoutubeCookieLease>();
  private creating = new Set<Promise<YoutubeCookieLease>>();
  private closed = false;
  private lifetime = new AbortController();

  private async fetch(options: YoutubeCookieOptions): Promise<string> {
    const client = new SecretsManagerClient({
      region: options.region,
      maxAttempts: 2,
    });
    let value: unknown;
    try {
      const result = await client.send(
        new GetSecretValueCommand({ SecretId: options.secretId }),
        {
          abortSignal: AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      value = result.SecretString;
    } catch (error) {
      const sanitized = failure(
        this.closed ? "cancelled" : secretFailure(error),
        true,
      );
      log("youtube_cookie_secret_fetch", {
        ok: false,
        classification: sanitized.details.classification,
      });
      throw sanitized;
    } finally {
      client.destroy();
    }
    log("youtube_cookie_secret_fetch", { ok: true });
    try {
      return validateYoutubeCookies(value);
    } catch (error) {
      const sanitized =
        error instanceof ProcessFailure
          ? error
          : failure("cookie_format_invalid");
      log("youtube_cookie_file_ready", {
        ok: false,
        classification: sanitized.details.classification,
      });
      throw sanitized;
    }
  }

  async acquire(
    options: YoutubeCookieOptions,
    signal: AbortSignal,
  ): Promise<YoutubeCookieLease> {
    if (!options.enabled || this.closed) throw failure("cookie_store_closed");
    signal.throwIfAborted();
    const work = this.create(options, signal);
    this.creating.add(work);
    try {
      return await work;
    } finally {
      this.creating.delete(work);
    }
  }

  private async create(
    options: YoutubeCookieOptions,
    signal: AbortSignal,
  ): Promise<YoutubeCookieLease> {
    const key = JSON.stringify([options.region, options.secretId]);
    let snapshot = this.snapshots.get(key);
    if (!snapshot) {
      snapshot = this.fetch(options);
      this.snapshots.set(key, snapshot);
    }
    // Cancelling a track must not cancel another track's shared Secret request.
    const contents = await waitWithAbort(snapshot, signal);
    signal.throwIfAborted();
    if (this.closed) throw failure("cookie_store_closed");
    let directory: string | undefined;
    try {
      if (!isAbsolute(tmpdir())) throw failure("cookie_file_io");
      const root = await realpath(tmpdir());
      const fromProject = relative(await realpath(process.cwd()), root);
      // Do not let TMPDIR redirect credential files into the working tree.
      const outsideProject =
        fromProject === ".." ||
        fromProject.startsWith(`..${sep}`) ||
        isAbsolute(fromProject);
      if (!isAbsolute(root) || !outsideProject) throw failure("cookie_file_io");
      directory = await mkdtemp(join(root, "popon-youtube-"));
      await chmod(directory, 0o700);
      const path = join(directory, "cookies.txt");
      await writeFile(path, contents, { mode: 0o600, flag: "wx" });
      await chmod(path, 0o600);
      signal.throwIfAborted();
      if (this.closed) throw failure("cookie_store_closed");
      const ownedDirectory = directory;
      const processes = new Set<Promise<unknown>>();
      let released: Promise<void> | undefined;
      const lease: YoutubeCookieLease = {
        path,
        holdUntil(done) {
          processes.add(done);
          void done.catch(() => {});
        },
        release: () =>
          (released ??= (async () => {
            // yt-dlp writes its jar on exit. Never unlink it while a child still owns it.
            await Promise.allSettled([...processes]);
            try {
              await rm(ownedDirectory, {
                recursive: true,
                force: true,
                maxRetries: 2,
              });
              log("youtube_cookie_file_removed", { ok: true });
            } catch {
              log("youtube_cookie_file_removed", {
                ok: false,
                classification: "cookie_file_io",
              });
            } finally {
              this.leases.delete(lease);
            }
          })()),
      };
      this.leases.add(lease);
      log("youtube_cookie_file_ready", {
        ok: true,
        directoryMode: "0700",
        fileMode: "0600",
      });
      return lease;
    } catch (error) {
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch(() => {
          log("youtube_cookie_file_removed", {
            ok: false,
            classification: "cookie_file_io",
          });
        });
      if (signal.aborted) signal.throwIfAborted();
      const sanitized =
        error instanceof ProcessFailure ? error : failure("cookie_file_io");
      log("youtube_cookie_file_ready", {
        ok: false,
        classification: sanitized.details.classification,
      });
      throw sanitized;
    }
  }

  // Call after aborting media sessions, so held subprocesses can terminate.
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.creating]);
    await Promise.all([...this.leases].map((lease) => lease.release()));
    this.snapshots.clear();
  }
}

export const youtubeCookies = new YoutubeCookieStore();

export function youtubeCookieObserver(stage: "metadata" | "download") {
  let pending = "";
  let accountCookiesDetected = false;
  let cookieReadObserved = false;
  let cookieLoadFailed = false;
  let loginRequiredObserved = false;
  let cookiesInvalidated = false;
  function line(text: string) {
    if (/Found YouTube account cookies/.test(text))
      accountCookiesDetected = cookieReadObserved = true;
    if (/Downloading .*player API JSON/.test(text)) cookieReadObserved = true;
    if (
      /failed to load cookies|does not look like a Netscape format cookies file/i.test(
        text,
      )
    )
      cookieLoadFailed = true;
    if (
      /LOGIN_REQUIRED|login required|sign in to confirm|not a bot/i.test(text)
    )
      loginRequiredObserved = true;
    if (/YouTube account cookies are no longer valid/i.test(text))
      cookiesInvalidated = true;
  }
  return {
    consume(chunk: string) {
      pending += chunk;
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop()!.slice(-8192);
      for (const text of lines) line(text);
    },
    finish(
      outcome: "metadata_ok" | "completed" | "failed" | "cancelled",
      classification?: FailureClass,
    ) {
      line(pending);
      pending = "";
      log("youtube_cookie_auth_result", {
        stage,
        cookieFileProvided: true,
        cookieRead: cookieLoadFailed
          ? "failed"
          : cookieReadObserved
            ? "observed"
            : "unconfirmed",
        accountCookiesDetected,
        cookiesInvalidated,
        loginRequiredObserved,
        // A local cookie marker or public metadata success cannot prove server-side login.
        loginAcceptance: loginRequiredObserved ? "rejected" : "unverified",
        outcome: loginRequiredObserved ? "login_required" : outcome,
        ...(classification ? { classification } : {}),
      });
    },
  };
}
