import { generateKeyPairSync, sign } from "node:crypto";
import {
  DescribeServicesCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandNames, parseQueuedCommand } from "../src/commands.js";
import { CommandConsumer } from "../src/sqs.js";
import { createSqsDispatcher } from "../src/sqs-dispatch.js";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Client } from "discord.js";

const mocks = vi.hoisted(() => ({ ecs: vi.fn(), sqs: vi.fn() }));
vi.mock("@aws-sdk/client-ecs", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-ecs")>()),
  ECSClient: class {
    send = mocks.ecs;
  },
}));
vi.mock("@aws-sdk/client-sqs", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-sqs")>()),
  SQSClient: class {
    send = mocks.sqs;
  },
}));

const now = Date.parse("2026-11-17T00:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
let handler: typeof import("../lambda/discord-bot-interactions/index.mjs").handler;
const interaction = (command = "join") => ({
  type: 2,
  id: "123456789012345678",
  guild_id: "123456789012345670",
  channel_id: "123456789012345672",
  member: { user: { id: "123456789012345671" } },
  token: "mock-interaction-token-never-enqueue",
  data: {
    name: command,
    type: 1,
    options:
      command === "play"
        ? [{ name: "url", type: 3, value: "https://youtu.be/abcdefghijk" }]
        : [],
  },
});
function signed(
  body: unknown,
  options: { base64?: boolean; timestamp?: string } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = options.timestamp ?? String(now / 1000);
  return {
    requestContext: { http: { method: "POST" } },
    headers: {
      "X-Signature-Ed25519": sign(
        null,
        Buffer.from(timestamp + raw),
        privateKey,
      ).toString("hex"),
      "X-Signature-Timestamp": timestamp,
    },
    body: options.base64 ? Buffer.from(raw).toString("base64") : raw,
    isBase64Encoded: options.base64 ?? false,
  };
}
const bodyOf = (response: { body: string }) => JSON.parse(response.body);
const active = (desiredCount = 0) => ({
  services: [{ status: "ACTIVE", desiredCount }],
});

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.ecs
    .mockReset()
    .mockImplementation(async (command) =>
      command instanceof DescribeServicesCommand ? active() : {},
    );
  mocks.sqs.mockReset().mockResolvedValue({ MessageId: "message-id" });
  vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
  vi.stubEnv("SQS_QUEUE_URL", "https://sqs.example/discord-commands.fifo");
  vi.stubEnv("ECS_CLUSTER", "discord-bot-cluster");
  vi.stubEnv("ECS_SERVICE", "discord-bot-service");
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handler } = await import("../lambda/discord-bot-interactions/index.mjs"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "verifies raw signed PING (base64=%s) and returns PONG without AWS",
  async (base64) => {
    const response = await handler(
      signed('{ "type": 1, "text": "日本語" }', { base64 }),
    );
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ type: 1 });
    expect(mocks.ecs).not.toHaveBeenCalled();
    expect(mocks.sqs).not.toHaveBeenCalled();
  },
);
it.each(["tampered", "missing", "expired", "future", "invalid-key"])(
  "rejects %s signatures before AWS",
  async (mode) => {
    const event = signed(
      { type: 1 },
      {
        timestamp: String(
          now / 1000 +
            (mode === "expired" ? -301 : mode === "future" ? 301 : 0),
        ),
      },
    );
    if (mode === "tampered") event.body += " ";
    if (mode === "missing") event.headers["X-Signature-Ed25519"] = "";
    if (mode === "invalid-key") vi.stubEnv("DISCORD_PUBLIC_KEY", "invalid");
    expect((await handler(event)).statusCode).toBe(401);
    expect(mocks.ecs).not.toHaveBeenCalled();
    expect(mocks.sqs).not.toHaveBeenCalled();
  },
);
it("rejects signed non-POST and invalid JSON/object input safely", async () => {
  const event = signed({ type: 1 });
  event.requestContext.http.method = "GET";
  expect((await handler(event)).statusCode).toBe(405);
  for (const body of ["{", "null", "[]"])
    expect((await handler(signed(body))).statusCode).toBe(400);
  expect(mocks.ecs).not.toHaveBeenCalled();
});
it.each(["join", "play"])(
  "saves /%s to FIFO before requesting desiredCount=1",
  async (command) => {
    const order: string[] = [];
    mocks.ecs.mockImplementation(async (command) => {
      if (command instanceof DescribeServicesCommand) {
        order.push("describe");
        return active();
      }
      expect(command).toBeInstanceOf(UpdateServiceCommand);
      expect(command.input).toEqual({
        cluster: "discord-bot-cluster",
        service: "discord-bot-service",
        desiredCount: 1,
      });
      order.push("start");
      return {};
    });
    mocks.sqs.mockImplementation(async () => {
      order.push("enqueue");
      return {};
    });
    const response = await handler(signed(interaction(command)));
    expect(order).toEqual(["describe", "enqueue", "start"]);
    expect(bodyOf(response)).toMatchObject({ type: 4, data: { flags: 64 } });
    const sent = mocks.sqs.mock.calls[0]![0] as SendMessageCommand;
    expect(sent).toBeInstanceOf(SendMessageCommand);
    expect(sent.input).toMatchObject({
      MessageGroupId: interaction().guild_id,
      MessageDeduplicationId: interaction().id,
    });
    expect(
      parseQueuedCommand(sent.input.MessageBody!, now, 300000),
    ).toMatchObject({ name: command, userId: interaction().member.user.id });
    expect(bodyOf(response).data.content).toContain(
      command === "play"
        ? "再生要求を受け付けました"
        : "VC参加要求を受け付けました",
    );
    expect(sent.input.MessageBody).not.toContain(
      "mock-interaction-token-never-enqueue",
    );
  },
);
it.each(["join", "play"])(
  "does not start an additional task for /%s on a requested/running service",
  async (command) => {
    mocks.ecs.mockResolvedValue(active(1));
    await handler(signed(interaction(command)));
    expect(mocks.ecs).toHaveBeenCalledOnce();
    expect(mocks.ecs.mock.calls[0]![0]).toBeInstanceOf(DescribeServicesCommand);
    expect(mocks.sqs).toHaveBeenCalledOnce();
  },
);
it.each(commandNames)(
  "relays /%s in the exact Bot envelope",
  async (command) => {
    mocks.ecs.mockResolvedValue(active(1));
    await handler(signed(interaction(command)));
    const sent = mocks.sqs.mock.calls[0]![0] as SendMessageCommand;
    const parsed = parseQueuedCommand(sent.input.MessageBody!, now, 300000);
    expect(parsed.name).toBe(command === "queue" ? "list" : command);
    if (command === "play")
      expect(parsed.url).toBe("https://youtu.be/abcdefghijk");
  },
);
it.each(commandNames.filter((name) => name !== "join" && name !== "play"))(
  "does not queue /%s when the Bot is stopped",
  async (command) => {
    const response = await handler(signed(interaction(command)));
    expect(bodyOf(response).data.content).toContain("先に /join");
    expect(mocks.sqs).not.toHaveBeenCalled();
  },
);
it.each([
  { guild_id: undefined },
  { channel_id: "wrong" },
  { id: 123 },
  { member: undefined },
  { data: { name: "play", options: [] } },
  { data: { name: "play", options: [{ name: "url", type: 4, value: 3 }] } },
  { data: { name: "join", options: {} } },
  { data: { name: "join", type: 2 } },
  { data: { name: "unknown" } },
])("does not send invalid input to AWS: %j", async (override) => {
  await handler(signed({ ...interaction(), ...override }));
  expect(mocks.ecs).not.toHaveBeenCalled();
  expect(mocks.sqs).not.toHaveBeenCalled();
});
it.each(["join", "play"])(
  "coalesces concurrent and repeated /%s Interaction IDs within a warm instance",
  async (command) => {
    const request = signed(interaction(command));
    const results = await Promise.all([handler(request), handler(request)]);
    expect(results[0]).toEqual(results[1]);
    await handler(request);
    expect(mocks.sqs).toHaveBeenCalledOnce();
    expect(mocks.ecs).toHaveBeenCalledTimes(2);
  },
);
it("uses the same FIFO ID across separate Lambda instances", async () => {
  const request = signed(interaction("skip"));
  mocks.ecs.mockResolvedValue(active(1));
  await handler(request);
  vi.resetModules();
  const other = await import("../lambda/discord-bot-interactions/index.mjs");
  await other.handler(request);
  const inputs = mocks.sqs.mock.calls.map(
    ([command]) => (command as SendMessageCommand).input,
  );
  expect(inputs).toHaveLength(2);
  expect(inputs[0]?.MessageDeduplicationId).toBe(
    inputs[1]?.MessageDeduplicationId,
  );
  expect(inputs[0]?.MessageBody).toBe(inputs[1]?.MessageBody);
});
it.each(["join", "play"])(
  "does not start ECS for /%s if SQS fails and never logs raw errors",
  async (command) => {
    mocks.sqs.mockRejectedValue(
      Object.assign(new Error("secret-cookie-value signed-url"), {
        name: "AccessDeniedException",
      }),
    );
    const response = await handler(signed(interaction(command)));
    expect(bodyOf(response).data.content).toContain("受付を確認できません");
    expect(mocks.ecs).toHaveBeenCalledOnce();
    const logs = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(logs).toContain("access_denied");
    expect(logs).not.toContain("secret-cookie-value");
    expect(logs).not.toContain("mock-interaction-token-never-enqueue");
  },
);
it("retries scale-out after a queued join failed to start (same Interaction ID)", async () => {
  let starts = 0;
  mocks.ecs.mockImplementation(async (command) => {
    if (command instanceof DescribeServicesCommand) return active();
    if (++starts === 1) throw new Error("upstream secret");
    return {};
  });
  const request = signed(interaction());
  expect(bodyOf(await handler(request)).data.content).toContain(
    "保存しましたが",
  );
  expect(bodyOf(await handler(request)).data.content).toContain(
    "受け付けました",
  );
  expect(starts).toBe(2);
  expect(
    mocks.sqs.mock.calls.map(
      ([command]) => command.input.MessageDeduplicationId,
    ),
  ).toEqual([interaction().id, interaction().id]);
});
it.each([
  {},
  { failures: [{ reason: "MISSING" }], ...active() },
  { services: [{ status: "INACTIVE", desiredCount: 0 }] },
  active(2),
])(
  "rejects missing/inactive/multiple-task service state without enqueue: %j",
  async (service) => {
    mocks.ecs.mockResolvedValue(service);
    await handler(signed(interaction()));
    expect(mocks.sqs).not.toHaveBeenCalled();
  },
);
it("reports DescribeServices failures without enqueuing", async () => {
  mocks.ecs.mockRejectedValue(new Error("API failure"));
  await handler(signed(interaction()));
  expect(mocks.sqs).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
    "describe_service",
  );
});
it("rejects missing configuration before AWS calls", async () => {
  vi.stubEnv("ECS_SERVICE", "");
  await handler(signed(interaction()));
  expect(mocks.ecs).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
    "configuration_missing",
  );
});
it("aborts a stalled AWS call and returns within the 2200ms handler budget", async () => {
  let signal: AbortSignal | undefined;
  mocks.ecs.mockImplementation((_command, options) => {
    signal = options.abortSignal;
    return new Promise(() => {});
  });
  const pending = handler(signed(interaction()));
  await vi.advanceTimersByTimeAsync(2200);
  const response = await pending;
  expect(signal?.aborted).toBe(true);
  expect(response.statusCode).toBe(200);
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
    "response_deadline",
  );
  expect(mocks.sqs).not.toHaveBeenCalled();
});
it("shortens the AWS budget to leave time before Lambda timeout", async () => {
  mocks.ecs.mockImplementation(() => new Promise(() => {}));
  const pending = handler(signed(interaction()), {
    getRemainingTimeInMillis: () => 800,
  });
  await vi.advanceTimersByTimeAsync(700);
  expect((await pending).statusCode).toBe(200);
});
it("uses one shared deadline across enqueue and scale-out and reports partial acceptance", async () => {
  mocks.sqs.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {};
  });
  mocks.ecs.mockImplementation(async (command) =>
    command instanceof DescribeServicesCommand
      ? active()
      : new Promise(() => {}),
  );
  const pending = handler(signed(interaction()));
  await vi.advanceTimersByTimeAsync(2200);
  expect(bodyOf(await pending).data.content).toContain("保存しましたが");
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
    "start_service",
  );
});
it.each([-300, 61])(
  "rejects signature timestamp offset %s seconds incompatible with the Bot TTL",
  async (offset) => {
    const response = await handler(
      signed(interaction(), { timestamp: String(now / 1000 + offset) }),
    );
    expect(response.statusCode).toBe(401);
    expect(mocks.sqs).not.toHaveBeenCalled();
  },
);
it("does not cache a request that had insufficient remaining Lambda time", async () => {
  const request = signed(interaction());
  expect(
    bodyOf(await handler(request, { getRemainingTimeInMillis: () => 50 })).data
      .content,
  ).toContain("受付時間");
  expect(mocks.ecs).not.toHaveBeenCalled();
  await handler(request);
  expect(mocks.sqs).toHaveBeenCalledOnce();
});
it("passes a real signed Lambda message through the Bot FIFO consumer and dispatcher", async () => {
  await handler(signed(interaction()));
  const sent = mocks.sqs.mock.calls[0]![0] as SendMessageCommand;
  const voice = { id: "actual-vc" };
  const execute = vi.fn(async () => {});
  const remove = vi.fn(async () => ({}));
  const client = {
    isReady: () => true,
    guilds: {
      cache: new Map([
        [
          interaction().guild_id,
          {
            id: interaction().guild_id,
            available: true,
            voiceStates: {
              cache: new Map([
                [interaction().member.user.id, { channel: voice }],
              ]),
            },
          },
        ],
      ]),
    },
    channels: {
      fetch: async () => ({
        guildId: interaction().guild_id,
        isSendable: () => true,
        send: async () => {},
      }),
    },
  } as unknown as Client;
  const consumer = new CommandConsumer(
    { send: remove } as unknown as SQSClient,
    {
      queueUrl: "queue-url",
      ttlMs: 300000,
      now: () => now,
      handle: createSqsDispatcher(client, execute),
    },
  );
  const message = {
    Body: sent.input.MessageBody,
    ReceiptHandle: "receipt",
    Attributes: { MessageGroupId: sent.input.MessageGroupId! },
  };
  await consumer.process(message);
  await consumer.process(message);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ name: "join", voiceChannel: voice }),
  );
  expect(remove).toHaveBeenCalledTimes(2);
  await consumer.stop();
});
