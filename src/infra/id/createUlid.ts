import { randomBytes } from "node:crypto";

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(timeMs: number): string {
  let value = Math.floor(timeMs);
  let encoded = "";

  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD32[value % 32] + encoded;
    value = Math.floor(value / 32);
  }

  return encoded;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let encoded = "";

  for (const value of bytes) {
    encoded += CROCKFORD32[value & 31];
  }

  return encoded;
}

export function createUlid(now = Date.now()): string {
  return `${encodeTime(now)}${encodeRandom(16)}`;
}
