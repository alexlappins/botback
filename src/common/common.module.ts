import { Global, Module } from '@nestjs/common';
import { GuildStorageService } from './storage/guild-storage.service';
import { SecurityBridge } from './security-bridge.service';

@Global()
@Module({
  providers: [GuildStorageService, SecurityBridge],
  exports: [GuildStorageService, SecurityBridge],
})
export class CommonModule {}
