import { expect, it, vi } from "vitest";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { queueAppearsEmpty, serviceStopper } from "../src/aws-service.js";
const ecs = vi.hoisted(() => ({ send: vi.fn(async () => ({})) }));
vi.mock("@aws-sdk/client-ecs", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-ecs")>()),
  ECSClient: class {
    send = ecs.send;
  },
}));

it("uses task-role credentials implicitly and changes only the configured service to desiredCount zero", async () => {
  await serviceStopper(
    "ap-northeast-1",
    "discord-bot-cluster",
    "discord-bot-service",
  )();
  expect(ecs.send.mock.calls[0]?.[0]).toBeInstanceOf(UpdateServiceCommand);
  expect(ecs.send.mock.calls[0]?.[0]).toMatchObject({
    input: {
      cluster: "discord-bot-cluster",
      service: "discord-bot-service",
      desiredCount: 0,
    },
  });
});

it("never treats missing or nonzero queue statistics as a safe stop condition", async () => {
  const send = vi.fn();
  const sqs = { send } as unknown as SQSClient;
  send.mockResolvedValueOnce({});
  expect(await queueAppearsEmpty(sqs, "queue-url")).toBe(false);
  send.mockResolvedValueOnce({
    Attributes: {
      ApproximateNumberOfMessages: "0",
      ApproximateNumberOfMessagesNotVisible: "1",
      ApproximateNumberOfMessagesDelayed: "0",
    },
  });
  expect(await queueAppearsEmpty(sqs, "queue-url")).toBe(false);
  send.mockResolvedValueOnce({
    Attributes: {
      ApproximateNumberOfMessages: "0",
      ApproximateNumberOfMessagesNotVisible: "0",
      ApproximateNumberOfMessagesDelayed: "0",
    },
  });
  expect(await queueAppearsEmpty(sqs, "queue-url")).toBe(true);
  send.mockRejectedValueOnce(new Error("access denied"));
  await expect(queueAppearsEmpty(sqs, "queue-url")).rejects.toThrow();
});
