import { describe, expect, it, vi } from "vitest";

import { AdapterHttpStatusError } from "../../src/adapters/http/HttpJsonClient.js";
import { HttpTelegramNotifierGateway } from "../../src/adapters/telegram/HttpTelegramNotifierGateway.js";

describe("http telegram notifier gateway", () => {
  it("sends sendMessage to Telegram bot API", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 1,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    );

    const gateway = new HttpTelegramNotifierGateway({
      botToken: "telegram-token",
      baseUrl: "https://api.telegram.test",
      fetchFn,
    });

    const result = await gateway.sendMessage({
      recipient: "chat_001",
      message: "hello world",
    });

    expect(result).toEqual({
      delivered: true,
      channel: "telegram",
      recipient: "chat_001",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://api.telegram.test/bottelegram-token/sendMessage",
    );
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        chat_id: "chat_001",
        text: "hello world",
      }),
    });
  });

  it("formats sendAlert as title plus body", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 2,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    );

    const gateway = new HttpTelegramNotifierGateway({
      botToken: "telegram-token",
      baseUrl: "https://api.telegram.test",
      fetchFn,
    });

    await gateway.sendAlert({
      recipient: "chat_001",
      title: "Critical alert",
      body: "Position requires reconciliation",
    });

    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        chat_id: "chat_001",
        text: "Critical alert\n\nPosition requires reconciliation",
      }),
    });
  });

  it("surfaces HTTP failures through adapter error mapping", async () => {
    const gateway = new HttpTelegramNotifierGateway({
      botToken: "telegram-token",
      baseUrl: "https://api.telegram.test",
      fetchFn: async () =>
        new Response("forbidden", {
          status: 403,
        }),
    });

    await expect(
      gateway.sendMessage({
        recipient: "chat_001",
        message: "hello world",
      }),
    ).rejects.toBeInstanceOf(AdapterHttpStatusError);
  });
});
