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
