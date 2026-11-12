import { expect, it, vi } from "vitest";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { queueAppearsEmpty } from "../src/aws-service.js";

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
