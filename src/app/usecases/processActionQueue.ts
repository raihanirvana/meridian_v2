import type { Action } from "../../domain/entities/Action.js";

import {
  type ActionQueue,
  type QueueActionHandler,
} from "../services/ActionQueue.js";

export interface ProcessActionQueueInput {
  actionQueue: ActionQueue;
  handler: QueueActionHandler;
}

export async function processActionQueue(
  input: ProcessActionQueueInput,
): Promise<Action[]> {
  return input.actionQueue.processAll(input.handler);
}
