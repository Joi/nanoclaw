export type GidcCommand =
  | { type: "mode"; value: "listening" | "available" }
  | { type: "scan" };

export function parseGidcCommand(text: string): GidcCommand | null {
  const normalized = text.trim().toLowerCase();

  const modeMatch = normalized.match(/^mode\s+(listening|available)$/);
  if (modeMatch) {
    return { type: "mode", value: modeMatch[1] as "listening" | "available" };
  }

  if (/^scan$/.test(normalized)) {
    return { type: "scan" };
  }

  return null;
}
