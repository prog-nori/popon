import { afterEach, expect, it, vi } from "vitest";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { InvalidCommand } from "../src/commands.js";
import { CommandConsumer } from "../src/sqs.js";

const now = 1800000000000;
const message = (): Message => ({
  Body: JSON.stringify({
    interaction_id: "123",
    guild_id: "456",
    user_id: "789",
    channel_id: "101",
    command: "join",
    options: [],
    created_at: now / 1000,
  }),
  ReceiptHandle: "receipt",
  Attributes: { MessageGroupId: "456" },
});
function fixture(handle = vi.fn(async () => {})) {
  const send = vi.fn(
    async (command: unknown, options?: unknown): Promise<object> => {
      void command;
      void options;
      return {};
    },
  );
  const consumer = new CommandConsumer({ send } as unknown as SQSClient, {
    queueUrl: "https://sqs.example/commands.fifo",
    ttlMs: 300000,
    handle,
    now: () => now,
  });
  return { consumer, send, handle };
}
afterEach(() => vi.useRealTimers());

it("deletes only after acceptance and never repeats a command after delete fails", async () => {
  const { consumer, send, handle } = fixture();
  let deleted = 0;
  send.mockImplementation(async (command) => {
    expect(command).toBeInstanceOf(DeleteMessageCommand);
    expect(handle).toHaveBeenCalledOnce();
    if (++deleted === 1) throw new Error("delete failed");
    return {};
  });
  await expect(consumer.process(message())).rejects.toThrow("delete failed");
  await consumer.process({ ...message(), ReceiptHandle: "new-receipt" });
  expect(handle).toHaveBeenCalledOnce();
  expect(send.mock.lastCall?.[0]).toMatchObject({
    input: { ReceiptHandle: "new-receipt" },
  });
});

it("keeps transient execution failures available for redelivery", async () => {
  const handle = vi.fn(async () => {
    throw new Error("gateway disconnected");
  });
  const { consumer, send } = fixture(handle);
  await expect(consumer.process(message())).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  handle.mockResolvedValue(undefined);
  await consumer.process(message());
  expect(handle).toHaveBeenCalledTimes(2);
  expect(send.mock.lastCall?.[0]).toBeInstanceOf(DeleteMessageCommand);
});

it("discards poison, stale and mismatched-group messages without executing them", async () => {
  const { consumer, send, handle } = fixture();
  await consumer.process({ ...message(), Body: "invalid" });
  const stale = JSON.parse(message().Body!);
  stale.created_at -= 301;
  await consumer.process({ ...message(), Body: JSON.stringify(stale) });
  await consumer.process({
    ...message(),
    Attributes: { MessageGroupId: "wrong-guild" },
  });
  expect(handle).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(3);
});

it("acknowledges permanent rejections but leaves no-success-on-error ambiguity", async () => {
  const { consumer, send } = fixture(
    vi.fn(async () => {
      throw new InvalidCommand("not_available");
    }),
  );
  await consumer.process(message());
  expect(send.mock.lastCall?.[0]).toBeInstanceOf(DeleteMessageCommand);
});

it("renews visibility while work is pending and cancels the heartbeat after acceptance", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const handle = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { consumer, send } = fixture(handle);
  const pending = consumer.process(message());
  await vi.advanceTimersByTimeAsync(30000);
  expect(send.mock.lastCall?.[0]).toBeInstanceOf(
    ChangeMessageVisibilityCommand,
  );
  finish();
  await pending;
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(send).toHaveBeenCalledTimes(count);
});

it("does not delete an in-progress command when shutdown interrupts it", async () => {
  let finish!: () => void;
  const { consumer, send } = fixture(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const pending = consumer.process(message());
  await consumer.stop();
  finish();
  await pending;
  expect(send).not.toHaveBeenCalled();
});

it("long-polls with one FIFO message and promptly aborts the request on shutdown", async () => {
  const { consumer, send } = fixture();
  send.mockImplementation(async (command, options) => {
    expect(command).toBeInstanceOf(ReceiveMessageCommand);
    expect(command).toMatchObject({
      input: {
        WaitTimeSeconds: 20,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 120,
      },
    });
    await new Promise((_, reject) => {
      (options as { abortSignal: AbortSignal }).abortSignal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
    return {};
  });
  const loop = consumer.start();
  await consumer.stop();
  await loop;
  expect(send).toHaveBeenCalledOnce();
});

it("retries an SQS receive failure without terminating the application", async () => {
  const { consumer, send } = fixture();
  send.mockRejectedValueOnce(new Error("AccessDenied"));
  send.mockImplementation(async (_command, options) => {
    void _command;
    return new Promise((_, reject) => {
      (options as { abortSignal: AbortSignal }).abortSignal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
  });
  const loop = consumer.start();
  try {
    // node:timers/promises uses real timers rather than Vitest's global timers.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), {
      timeout: 2500,
    });
  } finally {
    await consumer.stop();
    await loop;
  }
});
