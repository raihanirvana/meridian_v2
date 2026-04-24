import type { UserConfig } from "../../infra/config/configSchema.js";

export interface ResolveAdaptiveScreeningIntervalInput {
  defaultIntervalSec: number;
  timezone: string;
  peakHours: UserConfig["screening"]["peakHours"];
  now?: Date;
}

function parseMinutes(value: string): number {
  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  return hours * 60 + minutes;
}

function minutesInTimezone(now: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? "0",
  );
  return hour * 60 + minute;
}

function isWithinWindow(
  currentMinutes: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function resolveAdaptiveScreeningIntervalSec(
  input: ResolveAdaptiveScreeningIntervalInput,
): number {
  const currentMinutes = minutesInTimezone(
    input.now ?? new Date(),
    input.timezone,
  );

  const matchingIntervals = input.peakHours
    .filter((window) =>
      isWithinWindow(
        currentMinutes,
        parseMinutes(window.start),
        parseMinutes(window.end),
      ),
    )
    .map((window) => window.intervalSec);

  if (matchingIntervals.length === 0) {
    return input.defaultIntervalSec;
  }

  return Math.min(...matchingIntervals);
}
