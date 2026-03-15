# Код авторизации (Discord OAuth + session)

NestJS, express-session, passport, passport-discord. Фронт на другом порту (5173), callback на 5173, proxy /api → 3000. CORS с явным origin (FRONTEND_URL), без cookie.domain.

---

## 1. Точка входа: `src/main.ts`

Подключение сессии и passport до любых роутов. Порядок: session → passport.initialize() → passport.session(). Сериализация сессии — только через SessionSerializer в AuthModule (в main.ts не задаётся).

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import session from 'express-session';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const secret = process.env.SESSION_SECRET || 'change-me-in-production';
  const frontendUrl = process.env.FRONTEND_URL || '';
  const isLocalhost = frontendUrl.includes('localhost') || !frontendUrl;
  app.use(
    session({
      secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: !isLocalhost,
        sameSite: 'lax',
      },
    }),
  );

  const passport = (await import('passport')).default;
  app.use(passport.initialize());
  app.use(passport.session());

  const corsOrigin = process.env.FRONTEND_URL || 'http://localhost:5173';
  app.enableCors({ origin: corsOrigin, credentials: true });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`HTTP server: http://localhost:${port}`);
}

bootstrap();
```

---

## 2. Модуль: `src/auth/auth.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DiscordStrategy } from './discord.strategy';
import { SessionSerializer } from './session.serializer';
import { SessionGuard } from './session.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'discord', session: true }),
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, DiscordStrategy, SessionSerializer, SessionGuard],
  exports: [AuthService],
})
export class AuthModule {}
```

---

## 3. Контроллер: `src/auth/auth.controller.ts`

- `GET /api/auth/discord` — редирект на Discord OAuth.
- `GET /api/auth/callback` — callback после авторизации; перед редиректом вызывается `req.session.save()`, чтобы в ответ попала Set-Cookie.
- `GET /api/auth/me` — текущий пользователь (требуется сессия, SessionGuard).
- `GET /api/auth/logout` — выход и редирект на FRONTEND_URL или /.

```typescript
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { SessionGuard } from './session.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly config: ConfigService) {}

  @Get('discord')
  @UseGuards(AuthGuard('discord'))
  discordLogin() {
    // Passport redirects to Discord
  }

  @Get('callback')
  @UseGuards(AuthGuard('discord'))
  discordCallback(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.config.get<string>('FRONTEND_URL', '');
    const session = req.session as { save: (cb: (err?: Error) => void) => void };
    session.save((err?: Error) => {
      if (err) {
        res.status(500).json({ error: 'Session save failed' });
        return;
      }
      res.redirect(frontendUrl || '/');
    });
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: Request) {
    return (req as Request & { user: unknown }).user;
  }

  @Get('logout')
  logout(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.config.get<string>('FRONTEND_URL', '');
    req.logout((err) => {
      if (err) {
        res.status(500).json({ error: 'Logout failed' });
        return;
      }
      req.session.destroy(() => {
        res.redirect(frontendUrl || '/');
      });
    });
  }
}
```

---

## 4. Стратегия Discord: `src/auth/discord.strategy.ts`

Читает из env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_CALLBACK_URL. Scope: identify, guilds. В сессию сохраняется объект пользователя + accessToken (для последующих запросов к Discord API от имени пользователя).

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Profile } from 'passport-discord';
import { Strategy } from 'passport-discord';
import type { SessionUser } from './session.serializer';

@Injectable()
export class DiscordStrategy extends PassportStrategy(Strategy, 'discord') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('DISCORD_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('DISCORD_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('DISCORD_CALLBACK_URL'),
      scope: ['identify', 'guilds'],
    });
  }

  validate(
    accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): SessionUser {
    return {
      id: profile.id,
      username: profile.username ?? '',
      avatar: profile.avatar ?? null,
      discriminator: (profile as { discriminator?: string }).discriminator ?? '0',
      accessToken,
    };
  }
}
```

---

## 5. Сериализация сессии: `src/auth/session.serializer.ts`

В сессию кладётся весь объект SessionUser (в т.ч. accessToken); при десериализации он же возвращается в req.user.

```typescript
import { Injectable } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';

export interface SessionUser {
  id: string;
  username: string;
  avatar: string | null;
  discriminator: string;
  accessToken: string;
}

@Injectable()
export class SessionSerializer extends PassportSerializer {
  serializeUser(user: SessionUser, done: (err: Error | null, payload: SessionUser) => void): void {
    done(null, user);
  }

  deserializeUser(payload: SessionUser, done: (err: Error | null, user: SessionUser) => void): void {
    done(null, payload);
  }
}
```

SessionSerializer — единственное место сериализации/десериализации; в main.ts вызовов serializeUser/deserializeUser нет.

---

## 6. Guard для защищённых роутов: `src/auth/session.guard.ts`

Проверяет наличие req.user; если нет — 401 Unauthorized.

```typescript
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as Request & { user?: unknown }).user;
    if (!user) {
      throw new UnauthorizedException('Not logged in');
    }
    return true;
  }
}
```

---

## 7. AuthService: `src/auth/auth.service.ts`

Пустой сервис, экспортируется модулем при необходимости расширения.

```typescript
import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthService {}
```

---

## 8. Типы Express: `src/types/express.d.ts`

Расширение типа Request для logout и session.

```typescript
declare global {
  namespace Express {
    interface Request {
      logout: (cb: (err: Error) => void) => void;
      session: { destroy: (cb: () => void) => void };
    }
  }
}

export {};
```

---

## Переменные окружения (.env)

- `DISCORD_CLIENT_ID` — Application ID приложения в Discord.
- `DISCORD_CLIENT_SECRET` — OAuth2 Client Secret.
- `DISCORD_CALLBACK_URL` — URL callback (у нас: `http://localhost:5173/api/auth/callback` при фронте на 5173).
- `SESSION_SECRET` — секрет для подписи сессий.
- `FRONTEND_URL` — куда редиректить после входа/выхода (у нас: `http://localhost:5173`); также используется для cookie domain=localhost при localhost.

В Discord Developer Portal в OAuth2 → Redirects должен быть добавлен тот же URL, что и в DISCORD_CALLBACK_URL.
