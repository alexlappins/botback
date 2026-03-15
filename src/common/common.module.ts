import { Global, Module } from '@nestjs/common';
import { GuildStorageService } from './storage/guild-storage.service';

@Global()
@Module({
  providers: [GuildStorageService],
  exports: [GuildStorageService],
})
export class CommonModule {}
