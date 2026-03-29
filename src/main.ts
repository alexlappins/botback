import { mkdirSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import session from 'express-session';

async function bootstrap() {
  const uploadsPath = join(process.cwd(), 'uploads');
  mkdirSync(uploadsPath, { recursive: true });

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(uploadsPath, { prefix: '/uploads/' });

  const secret = process.env.SESSION_SECRET || 'change-me-in-production';
  app.use(
    session({
      name: 'bot.sid',
      secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: false,
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
