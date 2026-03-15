import { Module } from '@nestjs/common';
import { ReactionRolesCommands } from './reaction-roles.commands';
import { ReactionRolesComponents } from './reaction-roles.components';

/**
 * Роли по реакции (MVP #2).
 * Выдача ролей при нажатии кнопки или реакции на сообщение.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [ReactionRolesCommands, ReactionRolesComponents],
  exports: [],
})
export class ReactionRolesModule {}
