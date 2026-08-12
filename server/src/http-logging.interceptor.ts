import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Observable, catchError, tap, throwError } from 'rxjs';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = request.header('x-request-id') ?? randomUUID().slice(0, 8);
    const startedAt = Date.now();
    const silentPoll = request.method === 'GET' && /^\/v1\/analysis\/[0-9a-f-]{36}$/i.test(request.path);

    response.setHeader('x-request-id', requestId);
    if (!silentPoll) this.logger.log(`[${requestId}] --> ${request.method} ${request.originalUrl}`);

    return next.handle().pipe(
      tap(() => {
        if (!silentPoll) this.logger.log(
          `[${requestId}] <-- ${request.method} ${request.originalUrl} ${response.statusCode} ${Date.now() - startedAt}ms`,
        );
      }),
      catchError((error: unknown) => {
        const status = this.statusOf(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `[${requestId}] <-- ${request.method} ${request.originalUrl} ${status} ${Date.now() - startedAt}ms: ${message}`,
        );
        return throwError(() => error);
      }),
    );
  }

  private statusOf(error: unknown): number {
    if (typeof error === 'object' && error !== null && 'getStatus' in error) {
      const getStatus = (error as { getStatus?: unknown }).getStatus;
      if (typeof getStatus === 'function') return getStatus.call(error) as number;
    }
    return 500;
  }
}
