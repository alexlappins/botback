import { mkdirSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import session from 'express-session';

async function bootstrap() {
  const uploadsPath = join(process.cwd(), 'uploads');
  mkdirSync(uploadsPath, { recursive: true });

  // Capture the raw bytes for the Twitch webhook BEFORE Nest's default JSON
  // body parsing eats them — HMAC verification requires the original buffer,
  // not a re-stringified JSON. Everything else keeps the normal JSON parser.
  // bodyParser is also disabled below so we don't double-parse on other routes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.useStaticAssets(uploadsPath, { prefix: '/uploads/' });

  // Twitch webhook: raw bytes go through, parsed JSON attached as req.body.
  app.use(
    '/api/twitch/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
  );
  // Stripe webhook: same story — signature verification needs the raw buffer.
  app.use(
    '/api/stripe/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
  );
  // Everything else: standard JSON + urlencoded.
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

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
