import { createPublicKey, verify } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  ECSClient,
  DescribeServicesCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
// One attempt per API within the HTTP response budget; a new /join can retry.
const sqs = new SQSClient({ region, maxAttempts: 1 });
const ecs = new ECSClient({ region, maxAttempts: 1 });
const SUPPORTED_COMMANDS = new Set([
  "join",
  "leave",
  "play",
  "skip",
  "pause",
  "resume",
  "stop",
  "queue",
  "list",
  "help",
]);
const DEDUP_MS = 300000;
const RESPONSE_BUDGET_MS = 2200;
const START_COMMANDS = new Set(["join", "play"]);
// Warm-container optimization only. FIFO deduplication also covers other instances.
const requests = new Map();
const isId = (value) => typeof value === "string" && /^\d{1,20}$/.test(value);

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
function reply(content) {
  return respond(200, { type: 4, data: { content, flags: 64 } });
}
function record(event, fields = {}) {
  // Never log request/response bodies, tokens, options or raw SDK errors.
  console.log(JSON.stringify({ event, ...fields }));
}
function failure(code) {
  return Object.assign(new Error(code), { code });
}
function classification(error, signal) {
  if (signal.aborted) return "response_deadline";
  if (
    [
      "service_unavailable",
      "service_count_invalid",
      "configuration_missing",
    ].includes(error?.code)
  )
    return error.code;
  if (
    ["AccessDenied", "AccessDeniedException", "UnauthorizedOperation"].includes(
      error?.name,
    )
  )
    return "access_denied";
  if (
    ["ThrottlingException", "Throttling", "RequestThrottled"].includes(
      error?.name,
    )
  )
    return "throttled";
  return "aws_api_failed";
}

// Verify exactly the received bytes, including Function URL base64 payloads.
function verifiedRequest(event) {
  const headers = Object.fromEntries(
    Object.entries(event?.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const signature = headers["x-signature-ed25519"];
  const timestamp = headers["x-signature-timestamp"];
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
  if (
    typeof event?.body !== "string" ||
    typeof signature !== "string" ||
    !/^[0-9a-fA-F]{128}$/.test(signature) ||
    typeof timestamp !== "string" ||
    !/^\d{1,12}$/.test(timestamp) ||
    !/^[0-9a-fA-F]{64}$/.test(publicKeyHex ?? "") ||
    Date.now() - Number(timestamp) * 1000 >= DEDUP_MS ||
    Number(timestamp) * 1000 - Date.now() > 60000
  )
    return;
  const rawBody = Buffer.from(
    event.body,
    event.isBase64Encoded ? "base64" : "utf8",
  );
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      verify(
        null,
        Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]),
        publicKey,
        Buffer.from(signature, "hex"),
      )
    )
      return { rawBody, timestamp: Number(timestamp) };
  } catch {
    /* Invalid requests have no AWS side effects. */
  }
}

function envelope(interaction, timestamp) {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const options = interaction.data?.options ?? [];
  if (
    ![
      interaction.id,
      interaction.guild_id,
      userId,
      interaction.channel_id,
    ].every(isId) ||
    !Array.isArray(options) ||
    options.length > 25 ||
    (interaction.data?.type !== undefined && interaction.data.type !== 1)
  )
    return;
  if (interaction.data.name === "play") {
    const urls = options.filter((option) => option?.name === "url");
    if (
      urls.length !== 1 ||
      urls[0].type !== 3 ||
      typeof urls[0].value !== "string" ||
      urls[0].value.length === 0 ||
      urls[0].value.length > 2048
    )
      return;
  }
  return {
    interaction_id: interaction.id,
    guild_id: interaction.guild_id,
    user_id: userId,
    channel_id: interaction.channel_id,
    command: interaction.data.name,
    options,
    // Preserve request age on replay rather than giving an old request a new TTL.
    created_at: timestamp,
  };
}

async function send(client, command, signal) {
  if (signal.aborted) throw failure("response_deadline");
  let onAbort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        onAbort = () => reject(failure("response_deadline"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
      client.send(command, { abortSignal: signal }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function dispatch(message, context, startedAt) {
  const remaining = context?.getRemainingTimeInMillis?.() ?? Infinity;
  const budget = Math.min(
    RESPONSE_BUDGET_MS - (Date.now() - startedAt),
    remaining - 100,
  );
  if (budget <= 0)
    throw Object.assign(failure("response_deadline"), {
      response: reply(
        "受付時間を確保できませんでした。もう一度実行してください。",
      ),
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const fields = { id: message.interaction_id, command: message.command };
  let stage = "configuration";
  let queued = false;
  try {
    if (
      ![
        process.env.SQS_QUEUE_URL,
        process.env.ECS_CLUSTER,
        process.env.ECS_SERVICE,
      ].every((value) => typeof value === "string" && value.length > 0)
    )
      throw failure("configuration_missing");
    stage = "describe_service";
    const result = await send(
      ecs,
      new DescribeServicesCommand({
        cluster: process.env.ECS_CLUSTER,
        services: [process.env.ECS_SERVICE],
      }),
      controller.signal,
    );
    const service = result.services?.[0];
    if (result.failures?.length || !service || service.status !== "ACTIVE")
      throw failure("service_unavailable");
    if (![0, 1].includes(service.desiredCount))
      throw failure("service_count_invalid");
    if (!START_COMMANDS.has(message.command) && service.desiredCount === 0)
      return reply(
        "BOTは停止中です。先に /join または /play を実行してください。",
      );

    stage = "enqueue";
    await send(
      sqs,
      new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageGroupId: message.guild_id,
        MessageDeduplicationId: message.interaction_id,
        MessageBody: JSON.stringify(message),
      }),
      controller.signal,
    );
    queued = true;
    record("interaction_enqueued", fields);

    if (START_COMMANDS.has(message.command) && service.desiredCount === 0) {
      stage = "start_service";
      await send(
        ecs,
        new UpdateServiceCommand({
          cluster: process.env.ECS_CLUSTER,
          service: process.env.ECS_SERVICE,
          desiredCount: 1,
        }),
        controller.signal,
      );
      record("service_start_requested", fields);
    }
    return reply(
      message.command === "join"
        ? "BOTの起動・VC参加要求を受け付けました。参加完了はBOTから通知します。"
        : message.command === "play"
          ? "BOTの起動・VC参加・再生要求を受け付けました。実際の結果はBOTから通知します。"
          : `/${message.command} を受け付けました。実行結果はBOTから通知します。`,
    );
  } catch (error) {
    record("interaction_dispatch_failed", {
      ...fields,
      stage,
      classification: classification(error, controller.signal),
      queued,
    });
    // Do not cache failures: retrying the same ID must be able to retry scale-out.
    throw Object.assign(failure("dispatch_failed"), {
      response: reply(
        queued
          ? `/${message.command} の要求は保存しましたが、BOTの起動確認に失敗しました。少し待ち、起動しない場合は /join を実行してください。`
          : "コマンドの受付を確認できませんでした。もう一度実行し、続く場合はAWSの設定を確認してください。",
      ),
    });
  } finally {
    clearTimeout(timer);
  }
}

export const handler = async (event, context) => {
  const startedAt = Date.now();
  const verified = verifiedRequest(event);
  if (!verified) return respond(401, { error: "Unauthorized" });
  if (event.requestContext?.http?.method !== "POST")
    return respond(405, { error: "Method Not Allowed" });
  let interaction;
  try {
    interaction = JSON.parse(verified.rawBody.toString("utf8"));
  } catch {
    return respond(400, { error: "Bad Request" });
  }
  if (
    !interaction ||
    typeof interaction !== "object" ||
    Array.isArray(interaction)
  )
    return respond(400, { error: "Bad Request" });
  if (interaction.type === 1) return respond(200, { type: 1 });
  if (interaction.type !== 2)
    return respond(400, { error: "Unsupported interaction" });
  if (!SUPPORTED_COMMANDS.has(interaction.data?.name))
    return reply("未対応のコマンドです。");
  const message = envelope(interaction, verified.timestamp);
  if (!message)
    return reply("サーバー内で正しいコマンドとオプションを指定してください。");

  for (const [id, entry] of requests)
    if (entry.expires <= startedAt) requests.delete(id);
  const previous = requests.get(message.interaction_id);
  if (previous) return previous.promise;
  if (requests.size >= 10000)
    return reply("受付が混み合っています。少し待って再実行してください。");
  const promise = dispatch(message, context, startedAt).catch((error) => {
    requests.delete(message.interaction_id);
    return (
      error.response ?? reply("受付に失敗しました。もう一度実行してください。")
    );
  });
  requests.set(message.interaction_id, {
    promise,
    expires: startedAt + DEDUP_MS,
  });
  return promise;
};
