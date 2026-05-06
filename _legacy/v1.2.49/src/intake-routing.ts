export type ChannelMode = 'listening' | 'available' | undefined;

export function shouldRunIntake(
  channelMode: ChannelMode,
  explicitIntakeCommand: boolean,
): boolean {
  const mode = channelMode ?? 'listening';
  if (mode === 'listening') {
    return true;
  }
  // available mode
  return explicitIntakeCommand;
}
