import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminGuard } from './admin.guard';
import { CustomerGuard } from './customer.guard';
import { DiscordStrategy } from './discord.strategy';
import { SessionSerializer } from './session.serializer';
import { SessionGuard } from './session.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'discord', session: true }),
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    DiscordStrategy,
    SessionSerializer,
    SessionGuard,
    AdminGuard,
    CustomerGuard,
  ],
  exports: [AuthService, SessionGuard, AdminGuard, CustomerGuard],
})
export class AuthModule {}
