import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServerTemplate } from './entities/server-template.entity';
import { TemplateCategory } from './entities/template-category.entity';
import { TemplateChannel } from './entities/template-channel.entity';
import { TemplateLogChannel } from './entities/template-log-channel.entity';
import { TemplateMessage } from './entities/template-message.entity';
import { TemplateReactionRole } from './entities/template-reaction-role.entity';
import { TemplateRole } from './entities/template-role.entity';
import { UserTemplateAccess } from './entities/user-template-access.entity';
import { NoCacheInterceptor } from './no-cache.interceptor';
import { TemplateAccessAdminController, TemplateAccessController } from './template-access.controller';
import { ServerTemplatesController } from './server-templates.controller';
import { TemplateInstallService } from './template-install.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServerTemplate,
      TemplateRole,
      TemplateCategory,
      TemplateChannel,
      TemplateMessage,
      TemplateReactionRole,
      TemplateLogChannel,
      UserTemplateAccess,
    ]),
  ],
  controllers: [ServerTemplatesController, TemplateAccessController, TemplateAccessAdminController],
  providers: [TemplateInstallService, NoCacheInterceptor],
  exports: [TemplateInstallService],
})
export class ServerTemplatesModule {}
