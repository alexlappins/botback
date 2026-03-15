import { Module } from '@nestjs/common';
import { MessageConstructorCommands } from './message-constructor.commands';

/**
 * Конструктор сообщений (MVP #1).
 * Создание и сохранение шаблонов, кастомное форматирование,
 * структурированные сообщения для администраторов сервера.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [MessageConstructorCommands],
  exports: [],
})
export class MessageConstructorModule {}
