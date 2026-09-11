import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import {
  OpsAlertService,
  opsAlertCategoryLabel,
  opsAlertTime,
} from '../ops-alert/ops-alert.service';
import { isFixationGuardConflict } from './client-fixation-safety.service';

@Injectable()
export class FixationFailureInterceptor implements NestInterceptor {
  private readonly logger = new Logger(FixationFailureInterceptor.name);

  constructor(private readonly opsAlerts: OpsAlertService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        // 2026-09-11 (аудит обращения владельца): заявку останавливает не
        // только сбой 500. Защита от двойной отправки отвечает 409, и для
        // брокера это такой же отказ сайта — раньше о нём никто не узнавал:
        // алерта не было, в лог 409 не попадает. Теперь оба случая шумят.
        const guardBlocked = isFixationGuardConflict(error);

        // Validation, auth and uniqueness conflicts are expected business
        // responses. Alert only when the fixation path failed technically.
        if (status >= 500 || guardBlocked) {
          const request = context.switchToHttp().getRequest<{
            user?: { id?: string };
            route?: { path?: string };
          }>();
          const brokerId = request?.user?.id || 'public/unknown';
          const route = request?.route?.path || 'fixation';
          const category = guardBlocked
            ? 'FIXATION_GUARD_BLOCKED'
            : this.classify(error, status);
          const reason =
            error instanceof Error ? error.message : 'неизвестная ошибка';

          this.logger.warn(
            `Фиксация не прошла: route=${route} broker=${brokerId} status=${status} category=${category} reason=${reason}`,
          );

          void this.opsAlerts.sendSafely(
            [
              guardBlocked
                ? '🟠 Рабочий сайт: заявку остановила защита от двойной отправки'
                : '🔴 Рабочий сайт: техническая ошибка при фиксации',
              `Раздел сайта: ${route}`,
              `Номер брокера: ${brokerId}`,
              `Код ответа сайта: ${status}`,
              `Причина: ${opsAlertCategoryLabel(category)}`,
              `Время: ${opsAlertTime()}`,
              guardBlocked
                ? 'Что сделать: проверить, не подавали ли на этот номер другую заявку в ту же минуту; брокеру видно человеческое сообщение.'
                : 'Что сделать: открыть «Админка → Все заявки от брокеров» и проверить заявку.',
            ].join('\n'),
            {
              dedupKey: `fixation-api:${category}`,
              cooldownMs: 5 * 60_000,
            },
          );
        }

        return throwError(() => error);
      }),
    );
  }

  private classify(error: unknown, status: number): string {
    const name = error instanceof Error ? error.name : '';
    if (name.startsWith('Prisma')) return 'DATABASE_ERROR';
    if (name === 'AbortError' || name === 'TimeoutError') return 'TIMEOUT';
    if (status === 502 || status === 503 || status === 504) return 'DEPENDENCY_UNAVAILABLE';
    return 'UNEXPECTED_ERROR';
  }
}
