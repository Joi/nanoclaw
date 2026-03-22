export type ChannelMode = 'listening' | 'available' | undefined;

export function shouldRunIntake(
  channelMode: ChannelMode,
  _botMentioned: boolean,
  explicitIntakeCommand: boolean,
): boolean {
  const mode = channelMode ?? 'listening';
  if (mode === 'listening') {
    return true;
  }
  // available mode
  return explicitIntakeCommand;
}

export function shouldRouteToAgent(
  _channelMode: ChannelMode,
  botMentioned: boolean,
  isDm: boolean,
): boolean {
  return botMentioned || isDm;
}
