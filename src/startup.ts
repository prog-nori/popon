/** 設定値やトークンを出力せず、ログイン失敗の対処手順を返す。 */
export function loginFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Used disallowed intents")) {
    return "DiscordでMessage Content Intentが許可されていません。Developer Portal → 対象アプリ → Bot → Privileged Gateway Intents → Message Content IntentをONにしてSave Changesを押し、npm run devを再実行してください。";
  }
  return "Discordへのログインに失敗しました。Botトークン、ネットワーク接続、Discord側の設定を確認してください。認証情報はログやチャットに貼らないでください。";
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
