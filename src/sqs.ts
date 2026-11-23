import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  InvalidCommand,
  parseQueuedCommand,
  type QueuedCommand,
} from "./commands.js";
import { log } from "./log.js";

export interface CommandConsumerOptions {
  queueUrl: string;
  ttlMs: number;
  handle: (command: QueuedCommand) => Promise<void>;
  activity?: () => void;
  onEmpty?: () => Promise<void>;
  now?: () => number;
}

export class CommandConsumer {
  private abort = new AbortController();
  private seen = new Map<string, number>();
  private task?: Promise<void>;
  private processing = false;
  constructor(
    private client: SQSClient,
    private options: CommandConsumerOptions,
  ) {}
  get isProcessing(): boolean {
    return this.processing;
  }
  start(): Promise<void> {
    this.task ??= this.run();
    return this.task;
  }
  async stop(): Promise<void> {
    this.abort.abort();
    await this.task;
  }
  private signal(timeoutMs = 30000): AbortSignal {
    return AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
  }
  /** Public for deterministic tests; normal callers use start(). */
  async process(message: Message): Promise<void> {
    if (this.abort.signal.aborted || !message.ReceiptHandle) return;
    this.processing = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing = false;
    try {
      const now = this.options.now?.() ?? Date.now();
      for (const [id, expires] of this.seen)
        if (expires <= now) this.seen.delete(id);
      let command: QueuedCommand;
      try {
        command = parseQueuedCommand(
          message.Body ?? "",
          now,
          this.options.ttlMs,
        );
        if (message.Attributes?.MessageGroupId !== command.guildId)
          throw new InvalidCommand("message_group_mismatch");
      } catch (error) {
        if (!(error instanceof InvalidCommand)) throw error;
        log("command_discarded", { reason: error.message });
        await this.remove(message);
        return;
      }
      if (this.seen.has(command.id)) {
        await this.remove(message);
        return;
      }
      // Do not evict still-live deduplication records under load.
      if (this.seen.size >= 10000) throw new Error("command_dedup_capacity");
      this.options.activity?.();
      heartbeat = setInterval(() => {
        if (renewing || this.abort.signal.aborted) return;
        renewing = true;
        void this.client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.options.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 120,
            }),
            { abortSignal: this.signal() },
          )
          .catch(() => {
            log("command_visibility_extension_failed", { id: command.id });
          })
          .finally(() => {
            renewing = false;
          });
      }, 30000);
      try {
        await this.options.handle(command);
      } catch (error) {
        if (!(error instanceof InvalidCommand)) throw error;
        log("command_rejected", { id: command.id, reason: error.message });
      }
      // Record acceptance before deleting: delete failures cannot replay side effects.
      this.seen.set(command.id, command.createdAt * 1000 + this.options.ttlMs);
      await this.remove(message);
    } finally {
      clearInterval(heartbeat);
      this.processing = false;
    }
  }
  private async remove(message: Message): Promise<void> {
    if (this.abort.signal.aborted) return;
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
      { abortSignal: this.signal() },
    );
  }
  private async run(): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            WaitTimeSeconds: 20,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 120,
            MessageSystemAttributeNames: ["MessageGroupId"],
            ReceiveRequestAttemptId: randomUUID(),
          }),
          { abortSignal: this.signal() },
        );
        if (this.abort.signal.aborted) break;
        if (response.Messages?.length) {
          for (const message of response.Messages) await this.process(message);
        } else await this.options.onEmpty?.();
        failures = 0;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        failures++;
        log("command_consumer_error", {
          name: error instanceof Error ? error.name : "Error",
        });
        await sleep(
          Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)),
          undefined,
          { signal: this.abort.signal },
        ).catch(() => {});
      }
    }
  }
}
