import { z } from "zod";

import { type MockBehavior, resolveMockBehavior } from "../mockBehavior.js";

export const SendMessageInputSchema = z.object({
  recipient: z.string().min(1),
  message: z.string().min(1),
});

export const SendAlertInputSchema = z.object({
  recipient: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
});

export const NotificationResultSchema = z.object({
  delivered: z.boolean(),
  channel: z.literal("telegram"),
  recipient: z.string().min(1),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export type SendAlertInput = z.infer<typeof SendAlertInputSchema>;
export type NotificationResult = z.infer<typeof NotificationResultSchema>;

export interface NotifierGateway {
  sendMessage(input: SendMessageInput): Promise<NotificationResult>;
  sendAlert(input: SendAlertInput): Promise<NotificationResult>;
}

export interface MockNotifierGatewayBehaviors {
  sendMessage: MockBehavior<NotificationResult>;
  sendAlert: MockBehavior<NotificationResult>;
}

export class MockNotifierGateway implements NotifierGateway {
  public constructor(
    private readonly behaviors: MockNotifierGatewayBehaviors,
  ) {}

  public async sendMessage(
    input: SendMessageInput,
  ): Promise<NotificationResult> {
    SendMessageInputSchema.parse(input);
    return NotificationResultSchema.parse(
      await resolveMockBehavior(this.behaviors.sendMessage),
    );
  }

  public async sendAlert(input: SendAlertInput): Promise<NotificationResult> {
    SendAlertInputSchema.parse(input);
    return NotificationResultSchema.parse(
      await resolveMockBehavior(this.behaviors.sendAlert),
    );
  }
}
