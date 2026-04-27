import { ChannelOption, RoleOption, StringOption } from 'necord';

export class SetupRoleDto {
  @ChannelOption({
    name: 'channel',
    description: 'Channel where the button message will be sent',
    required: true,
  })
  channel: { id: string };

  @RoleOption({
    name: 'role',
    description: 'Role to grant on click',
    required: true,
  })
  role: { id: string; name: string };

  @StringOption({
    name: 'text',
    description: 'Text above the button',
    required: false,
  })
  text?: string;
}
