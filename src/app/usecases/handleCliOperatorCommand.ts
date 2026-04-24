import {
  executeOperatorCommand,
  parseOperatorCommand,
  type ExecuteOperatorCommandInput,
  type OperatorCommandExecutionResult,
} from "./operatorCommands.js";

export interface HandleCliOperatorCommandInput extends Omit<
  ExecuteOperatorCommandInput,
  "command"
> {
  rawCommand: string;
}

export async function handleCliOperatorCommand(
  input: HandleCliOperatorCommandInput,
): Promise<OperatorCommandExecutionResult> {
  const command = parseOperatorCommand({
    raw: input.rawCommand,
  });

  return executeOperatorCommand({
    ...input,
    command,
  });
}
