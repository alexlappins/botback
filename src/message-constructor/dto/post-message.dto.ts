import { ChannelOption, StringOption } from 'necord';

export class PostMessageDto {
  @ChannelOption({
    name: 'канал',
    description: 'Канал, куда отправить сообщение',
    required: true,
  })
  channel: { id: string };

  @StringOption({
    name: 'заголовок',
    description: 'Заголовок сообщения (эмбед)',
    required: true,
  })
  title: string;

  @StringOption({
    name: 'описание',
    description: 'Текст описания (эмбед)',
    required: true,
  })
  description: string;

  @StringOption({
    name: 'картинка',
    description: 'URL картинки (необязательно)',
    required: false,
  })
  image?: string;
}
