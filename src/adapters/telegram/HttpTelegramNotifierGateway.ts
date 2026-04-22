import { z } from "zod";

import { JsonHttpClient, type FetchLike } from "../http/HttpJsonClient.js";

import {
  NotificationResultSchema,
  SendAlertInputSchema,
  SendMessageInputSchema,
  type NotificationResult,
  type NotifierGateway,
  type SendAlertInput,
  type SendMessageInput,
} from "./NotifierGateway.js";

const TelegramSendMessageResponseSchema = z
  .object({
    ok: z.boolean(),
    result: z
      .object({
        message_id: z.number().int().optional(),
      })
      .passthrough(),
  })
  .strict();

export interface HttpTelegramNotifierGatewayOptions {
  botToken: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class HttpTelegramNotifierGateway implements NotifierGateway {
  private readonly client: JsonHttpClient;

  public constructor(options: HttpTelegramNotifierGatewayOptions) {
    const botToken = z.string().min(1).parse(options.botToken);
    const baseUrl = options.baseUrl ?? "https://api.telegram.org";
    this.client = new JsonHttpClient({
      adapterName: "HttpTelegramNotifierGateway",
      baseUrl: `${z.url().parse(baseUrl).replace(/\/$/, "")}/bot${botToken}/`,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  public async sendMessage(input: SendMessageInput): Promise<NotificationResult> {
    const parsed = SendMessageInputSchema.parse(input);
    await this.client.request({
      method: "POST",
      path: "sendMessage",
      body: {
        chat_id: parsed.recipient,
        text: parsed.message,
      },
      responseSchema: TelegramSendMessageResponseSchema,
    });

    return NotificationResultSchema.parse({
      delivered: true,
      channel: "telegram",
      recipient: parsed.recipient,
    });
  }

  public async sendAlert(input: SendAlertInput): Promise<NotificationResult> {
    const parsed = SendAlertInputSchema.parse(input);
    return this.sendMessage({
      recipient: parsed.recipient,
      message: `${parsed.title}\n\n${parsed.body}`,
    });
  }
}
