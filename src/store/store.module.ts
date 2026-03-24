import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';
import { UserTemplateAccess } from '../server-templates/entities/user-template-access.entity';
import { Purchase } from './entities/purchase.entity';
import { StoreTemplate } from './entities/store-template.entity';
import { AdminStoreController, StoreController } from './store.controller';
import { StoreService } from './store.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StoreTemplate, Purchase, ServerTemplate, UserTemplateAccess]),
  ],
  controllers: [StoreController, AdminStoreController],
  providers: [StoreService],
})
export class StoreModule {}

