import { ChannelOption, StringOption } from 'necord';

export class PostMessageDto {
  @ChannelOption({
    name: 'channel',
    description: 'Channel to send the message to',
    required: true,
  })
  channel: { id: string };

  @StringOption({
    name: 'title',
    description: 'Message title (embed)',
    required: true,
  })
  title: string;

  @StringOption({
    name: 'description',
    description: 'Description text (embed)',
    required: true,
  })
  description: string;

  @StringOption({
    name: 'image',
    description: 'Image URL (optional)',
    required: false,
  })
  image?: string;
}
