export type MockBehavior<T> =
  | { type: "success"; value: T }
  | { type: "fail"; error: Error | string }
  | { type: "timeout"; timeoutMs?: number };

export async function resolveMockBehavior<T>(
  behavior: MockBehavior<T>,
): Promise<T> {
  if (behavior.type === "success") {
    return behavior.value;
  }

  if (behavior.type === "fail") {
    throw behavior.error instanceof Error
      ? behavior.error
      : new Error(behavior.error);
  }

  const timeoutMs = behavior.timeoutMs ?? 10;
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  throw new Error(`Mock timeout after ${timeoutMs}ms`);
}
