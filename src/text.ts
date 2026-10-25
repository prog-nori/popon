import { describeUrl } from "./urls.js";
export function normalize(
  text: string,
  dictionary: Record<string, string> = {},
): string {
  let result = text
    .replace(/```[\s\S]*?```/g, " コード省略 ")
    .replace(/<a?:([^:>]+):\d+>/g, " $1 ")
    .replace(/<@!?\d+>/g, " メンション ")
    .replace(/<@&\d+>/g, " ロール ")
    .replace(/<#\d+>/g, " チャンネル ")
    .replace(/https?:\/\/\S+/g, " リンクが送信されました ")
    .replace(/[*_~`|]/g, "")
    .replace(/(?:^|\s)[wｗ]{2,}(?=\s|$)/g, " 笑い ")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
  for (const [from, to] of Object.entries(dictionary))
    if (from) result = result.split(from).join(to);
  return result.replace(/\s+/g, " ").trim();
}
export async function speechText(
  name: string,
  content: string,
  attachments: readonly string[],
  dictionary: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const urls = [...content.matchAll(/https?:\/\/[^\s<>]+/g)].slice(0, 3);
  const descriptions = await Promise.all(
    urls.map((m) => describeUrl(m[0], signal)),
  );
  let index = 0;
  const replaced = content.replace(
    /https?:\/\/[^\s<>]+/g,
    () => descriptions[index++] ?? "リンクが送信されました",
  );
  const attachmentText = attachments.length
    ? attachments.some((type) => type.startsWith("image/"))
      ? " 画像が送信されました"
      : " ファイルが送信されました"
    : "";
  const body = normalize(replaced + attachmentText, dictionary).slice(0, 200);
  return body
    ? `${normalize(name, dictionary).slice(0, 32) || "ユーザー"} ${body}`
    : "";
}
