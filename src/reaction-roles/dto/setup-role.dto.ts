import { ChannelOption, RoleOption, StringOption } from 'necord';

export class SetupRoleDto {
  @ChannelOption({
    name: 'канал',
    description: 'Канал, где отправить сообщение с кнопкой',
    required: true,
  })
  channel: { id: string };

  @RoleOption({
    name: 'роль',
    description: 'Роль, которую выдавать по нажатию',
    required: true,
  })
  role: { id: string; name: string };

  @StringOption({
    name: 'текст',
    description: 'Текст сообщения над кнопкой',
    required: false,
  })
  text?: string;
}
