import type {
  NotifierGateway,
  NotificationResult,
} from "../../adapters/telegram/NotifierGateway.js";

export interface SendOperatorAlertInput {
  notifierGateway: NotifierGateway;
  recipient: string;
  title: string;
  body: string;
}

export async function sendOperatorAlert(
  input: SendOperatorAlertInput,
): Promise<NotificationResult> {
  return input.notifierGateway.sendAlert({
    recipient: input.recipient,
    title: input.title,
    body: input.body,
  });
}
