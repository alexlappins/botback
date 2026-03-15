import { ChannelOption, RoleOption, StringOption } from 'necord';

export class SetupEmojiRoleDto {
  @ChannelOption({
    name: 'канал',
    description: 'Канал, в котором находится сообщение',
    required: true,
  })
  channel: { id: string };

  @StringOption({
    name: 'id_сообщения',
    description: 'ID сообщения (ПКМ по сообщению → Копировать ссылку → последняя часть ссылки)',
    required: true,
  })
  messageId: string;

  @StringOption({
    name: 'эмодзи',
    description: 'Эмодзи (например ✅ или для кастомного: имя:id)',
    required: true,
  })
  emoji: string;

  @RoleOption({
    name: 'роль',
    description: 'Роль, которую выдавать по реакции',
    required: true,
  })
  role: { id: string; name: string };
}
