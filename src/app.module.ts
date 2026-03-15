import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DiscordModule } from './discord/discord.module';
import { LogsModule } from './logs/logs.module';
import { MessageConstructorModule } from './message-constructor/message-constructor.module';
import { ReactionRolesModule } from './reaction-roles/reaction-roles.module';
import { ServerTemplatesModule } from './server-templates/server-templates.module';
import { TemplatesModule } from './templates/templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('POSTGRES_HOST', 'localhost'),
        port: config.get('POSTGRES_PORT', 5432),
        username: config.get('POSTGRES_USER', 'postgres'),
        password: config.get('POSTGRES_PASSWORD', 'postgres'),
        database: config.get('POSTGRES_DB', 'postgres'),
        autoLoadEntities: true,
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    CommonModule,
    DiscordModule,
    AuthModule,
    DashboardModule,
    ServerTemplatesModule,
    TemplatesModule,
    MessageConstructorModule,
    ReactionRolesModule,
    LogsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
