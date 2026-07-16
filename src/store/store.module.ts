import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServerTemplatesModule } from '../server-templates/server-templates.module';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';
import { UserTemplateAccess } from '../server-templates/entities/user-template-access.entity';
import { PendingInstall } from './entities/pending-install.entity';
import { Purchase } from './entities/purchase.entity';
import { StoreTemplate } from './entities/store-template.entity';
import { InstallFlowService } from './install-flow.service';
import { AdminStoreController, StoreController } from './store.controller';
import { StoreService } from './store.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StoreTemplate, Purchase, PendingInstall, ServerTemplate, UserTemplateAccess]),
    ServerTemplatesModule,
  ],
  controllers: [StoreController, AdminStoreController],
  providers: [StoreService, InstallFlowService],
  exports: [StoreService],
})
export class StoreModule {}

