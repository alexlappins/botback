declare global {
  namespace Express {
    interface Request {
      user?: unknown;
      logIn: (user: Express.User, cb: (err: Error | null) => void) => void;
      logout: (cb: (err: Error) => void) => void;
      session: { save: (cb: (err?: Error) => void) => void; destroy: (cb: () => void) => void };
      sessionID?: string;
    }
  }
}

export {};
