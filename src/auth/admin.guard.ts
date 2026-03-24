import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from './session.serializer';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as Request & { user?: SessionUser }).user;
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}

