import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";

export function serviceScaler(
  region: string,
  cluster: string,
  service: string,
) {
  // Credentials come from the SDK's default provider chain (ECS task role).
  const ecs = new ECSClient({ region, maxAttempts: 2 });
  return async (desiredCount: number): Promise<void> => {
    if (!cluster || !service)
      throw new Error("ECS_CLUSTER/ECS_SERVICE are required");
    await ecs.send(
      new UpdateServiceCommand({ cluster, service, desiredCount }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
  };
}

export async function queueAppearsEmpty(
  sqs: SQSClient,
  queueUrl: string,
): Promise<boolean> {
  const keys = [
    "ApproximateNumberOfMessages",
    "ApproximateNumberOfMessagesNotVisible",
    "ApproximateNumberOfMessagesDelayed",
  ] as const;
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [...keys],
    }),
    { abortSignal: AbortSignal.timeout(10000) },
  );
  // Missing/error/approximate attributes never prove that stopping is safe.
  return keys.every((key) => result.Attributes?.[key] === "0");
}
