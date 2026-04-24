import type { NotifierGateway } from "../../adapters/telegram/NotifierGateway.js";
import { logger } from "../../infra/logging/logger.js";

import {
  executeOperatorCommand,
  parseOperatorCommand,
  type ExecuteOperatorCommandInput,
  type OperatorCommandExecutionResult,
} from "./operatorCommands.js";

export interface HandleTelegramOperatorCommandInput extends Omit<
  ExecuteOperatorCommandInput,
  "command"
> {
  notifierGateway: NotifierGateway;
  recipient: string;
  rawCommand: string;
}

export async function handleTelegramOperatorCommand(
  input: HandleTelegramOperatorCommandInput,
): Promise<OperatorCommandExecutionResult> {
  const command = parseOperatorCommand({
    raw: input.rawCommand,
  });
  const result = await executeOperatorCommand({
    ...input,
    command,
  });

  try {
    await input.notifierGateway.sendMessage({
      recipient: input.recipient,
      message: result.text,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        recipient: input.recipient,
        command: result.command,
      },
      "telegram operator reply failed after command execution",
    );
  }

  return result;
}
