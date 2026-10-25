import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function validateUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("URL rejected");
  return url;
}
async function fetchPage(
  url: URL,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ body: string; type: string }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Private destination");
  const target = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        signal,
        agent: false,
        headers: {
          "User-Agent": "Popon/0.1",
          Accept: "text/html",
          "Accept-Encoding": "identity",
        },
        lookup: (_host, options, callback) => {
          const deliver = callback as (
            error: Error | null,
            address: string | { address: string; family: number }[],
            family?: number,
          ) => void;
          deliver(null, options.all ? [target] : target.address, target.family);
        },
      },
      (response) => {
        const remote = response.socket.remoteAddress;
        if (
          !remote ||
          ipaddr.process(remote).toString() !==
            ipaddr.process(target.address).toString()
        ) {
          response.destroy();
          reject(new Error("Peer mismatch"));
          return;
        }
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.destroy();
          if (redirects >= 3 || !response.headers.location) {
            reject(new Error("Redirect limit"));
            return;
          }
          try {
            resolve(
              fetchPage(
                validateUrl(new URL(response.headers.location, url).href),
                signal,
                redirects + 1,
              ),
            );
          } catch (e) {
            reject(e);
          }
          return;
        }
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error("HTTP error"));
          return;
        }
        const type = response.headers["content-type"] ?? "";
        if (!type.includes("text/html")) {
          response.destroy();
          resolve({ body: "", type });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            response.destroy(new Error("Size limit"));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks).toString("utf8"), type }),
        );
      },
    );
    request.on("error", reject);
  });
}
export function siteName(html: string, hostname: string): string {
  const $ = load(html);
  const og = $('meta[property="og:site_name"]').attr("content")?.trim();
  if (og) return og.slice(0, 80);
  const known: Record<string, string> = {
    "www.youtube.com": "YouTube",
    "youtu.be": "YouTube",
    "www.nike.com": "NIKEオンラインストア",
    "nike.com": "NIKEオンラインストア",
    "github.com": "GitHub",
    "x.com": "エックス",
  };
  return known[hostname] ?? "リンクが送信されました";
}
export async function describeUrl(
  raw: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const timeout = AbortSignal.timeout(3000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const url = validateUrl(raw);
    const page = await Promise.race([
      fetchPage(url, combined),
      new Promise<never>((_, reject) =>
        combined.addEventListener("abort", () => reject(combined.reason), {
          once: true,
        }),
      ),
    ]);
    return page.type.startsWith("image/")
      ? "画像が送信されました"
      : siteName(page.body, url.hostname);
  } catch {
    return "リンクが送信されました";
  }
}
