import { ChannelOption, RoleOption, StringOption } from 'necord';

export class SetupEmojiRoleDto {
  @ChannelOption({
    name: 'channel',
    description: 'Channel that contains the message',
    required: true,
  })
  channel: { id: string };

  @StringOption({
    name: 'message_id',
    description: 'Message ID (right-click message > Copy Link > last part of the link)',
    required: true,
  })
  messageId: string;

  @StringOption({
    name: 'emoji',
    description: 'Emoji (e.g. checkmark, or for custom: name:id)',
    required: true,
  })
  emoji: string;

  @RoleOption({
    name: 'role',
    description: 'Role to grant on reaction',
    required: true,
  })
  role: { id: string; name: string };
}
