/** Return fixed diagnostic codes only; exception messages/values stay private. */
export function startupFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message === "DISCORD_TOKEN が環境変数に設定されていません" ||
    message === "DISCORD_TOKEN を .env に設定してください"
  )
    return "DISCORD_TOKEN_MISSING";
  if (message.includes("Used disallowed intents"))
    return "DISCORD_INTENTS_DISALLOWED";
  if (message === "TTS_MODE は external または process を指定してください")
    return "CONFIG_INVALID_TTS_MODE";
  if (message === "VOICEVOX_ARGS は文字列のJSON配列です")
    return "CONFIG_INVALID_VOICEVOX_ARGS";
  if (/^[A-Z_]+ の値が不正です$/.test(message)) return "CONFIG_INVALID_NUMBER";
  if (message === "辞書の値は文字列で指定してください")
    return "DICTIONARY_INVALID";
  if (message === "bot_startup_failed") return "BOT_STARTUP_FAILED";
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const failure = current as { code?: unknown; cause?: unknown };
    if (failure.code === "TokenInvalid" || failure.code === 4004)
      return "DISCORD_TOKEN_INVALID";
    if (failure.code === 4014) return "DISCORD_INTENTS_DISALLOWED";
    if (["ENOTFOUND", "EAI_AGAIN"].includes(failure.code as string))
      return "STARTUP_DNS_FAILED";
    if (
      ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(failure.code as string)
    )
      return "STARTUP_CONNECTION_TIMEOUT";
    if (
      ["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(
        failure.code as string,
      )
    )
      return "STARTUP_CONNECTION_FAILED";
    if (
      failure.code === "ERR_MODULE_NOT_FOUND" ||
      failure.code === "MODULE_NOT_FOUND"
    )
      return "STARTUP_DEPENDENCY_MISSING";
    if (failure.code === "ENOENT") return "STARTUP_FILE_MISSING";
    if (failure.code === "EACCES") return "STARTUP_FILE_ACCESS_DENIED";
    current = failure.cause;
  }
  if (error instanceof SyntaxError) return "STARTUP_PARSE_FAILED";
  return "STARTUP_FAILURE_UNCLASSIFIED";
}

/** 設定値やトークンを出力せず、ログイン失敗の対処手順を返す。 */
export function loginFailureMessage(error: unknown): string {
  const code = startupFailureCode(error);
  if (code === "DISCORD_INTENTS_DISALLOWED") {
    return `[${code}] DiscordでMessage Content Intentが許可されていません。Developer Portal → 対象アプリ → Bot → Privileged Gateway Intents → Message Content IntentをONにしてSave Changesを押してください。`;
  }
  return `[${code}] Discordへのログインに失敗しました。Botトークン、ネットワーク接続、Discord側の設定を確認してください。認証情報はログやチャットに貼らないでください。`;
}

export async function loginOrShutdown(
  login: () => Promise<unknown>,
  shutdown: () => Promise<void>,
  report: (message: string) => void,
): Promise<boolean> {
  try {
    await login();
    return true;
  } catch (error) {
    report(loginFailureMessage(error));
    await shutdown();
    return false;
  }
}
