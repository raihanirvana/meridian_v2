import { z } from "zod";

import { JsonHttpClient, type FetchLike } from "../http/HttpJsonClient.js";

const TelegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: z
      .object({
        text: z.string().min(1).optional(),
        chat: z
          .object({
            id: z.union([z.number().int(), z.string().min(1)]),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

const TelegramGetUpdatesResponseSchema = z
  .object({
    ok: z.boolean(),
    result: z.array(TelegramUpdateSchema),
  })
  .strict();

export interface TelegramOperatorUpdate {
  updateId: number;
  chatId: string;
  text: string;
}

export interface HttpTelegramOperatorGatewayOptions {
  botToken: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class HttpTelegramOperatorGateway {
  private readonly client: JsonHttpClient;
  private readonly botToken: string;

  public constructor(options: HttpTelegramOperatorGatewayOptions) {
    this.botToken = z.string().min(1).parse(options.botToken);
    const baseUrl = options.baseUrl ?? "https://api.telegram.org";
    this.client = new JsonHttpClient({
      adapterName: "HttpTelegramOperatorGateway",
      baseUrl: `${z.url().parse(baseUrl).replace(/\/$/, "")}/`,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  }

  private buildPath(path: string): string {
    return `bot${this.botToken}/${path}`;
  }

  public async getUpdates(input?: {
    offset?: number;
    timeoutSec?: number;
  }): Promise<TelegramOperatorUpdate[]> {
    const response = await this.client.request({
      method: "GET",
      path: this.buildPath("getUpdates"),
      query: {
        ...(input?.offset === undefined ? {} : { offset: input.offset }),
        ...(input?.timeoutSec === undefined
          ? {}
          : { timeout: input.timeoutSec }),
      },
      responseSchema: TelegramGetUpdatesResponseSchema,
    });

    return response.result.flatMap((update) => {
      const message = update.message;
      if (message === undefined) {
        return [];
      }

      const text = message?.text?.trim();
      if (text === undefined || text.length === 0) {
        return [];
      }

      return [
        {
          updateId: update.update_id,
          chatId: String(message.chat.id),
          text,
        },
      ];
    });
  }
}
