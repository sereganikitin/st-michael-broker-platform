import { BadRequestException, CallHandler, ConflictException, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { OpsAlertService } from '../ops-alert/ops-alert.service';
import { FixationFailureInterceptor } from './fixation-failure.interceptor';
import { FIXATION_GUARD_CONFLICT } from './client-fixation-safety.service';

describe('FixationFailureInterceptor', () => {
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: 'broker-1' }, route: { path: '/clients/fix' } }),
    }),
  } as unknown as ExecutionContext;

  it('alerts on an unexpected technical failure without request PII', async () => {
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const interceptor = new FixationFailureInterceptor(opsAlerts as unknown as OpsAlertService);
    const error = new Error('database connection contains sensitive details');
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(error);

    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    const message = opsAlerts.sendSafely.mock.calls[0][0] as string;
    expect(message).toContain('Номер брокера: broker-1');
    expect(message).toContain('Причина: непредвиденная техническая ошибка');
    expect(message).not.toContain('category:');
    expect(message).not.toContain('sensitive details');
  });

  it('does not alert on an expected 4xx response', async () => {
    const opsAlerts = { sendSafely: jest.fn() };
    const interceptor = new FixationFailureInterceptor(opsAlerts as unknown as OpsAlertService);
    const error = new BadRequestException('invalid form');
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(error);
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });

  // 2026-09-11 (аудит обращения владельца): защита от двойной отправки
  // отвечает 409, и раньше об этом никто не узнавал — ни алерта, ни строки
  // в логе. Для брокера это такой же отказ сайта, как и 500.
  it('шлёт алерт, когда заявку остановила защита от двойной отправки', async () => {
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const interceptor = new FixationFailureInterceptor(opsAlerts as unknown as OpsAlertService);
    const error = new ConflictException('По этому номеру сейчас обрабатывается другая заявка. Повторите через минуту.');
    Object.assign(error, { [FIXATION_GUARD_CONFLICT]: true });
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(error);

    expect(opsAlerts.sendSafely).toHaveBeenCalledTimes(1);
    const message = opsAlerts.sendSafely.mock.calls[0][0] as string;
    expect(message).toContain('защита от двойной отправки остановила заявку');
    expect(message).toContain('Номер брокера: broker-1');
    expect(message).toContain('Код ответа сайта: 409');
  });

  it('обычный конфликт уникальности алертом не считается', async () => {
    const opsAlerts = { sendSafely: jest.fn() };
    const interceptor = new FixationFailureInterceptor(opsAlerts as unknown as OpsAlertService);
    const error = new ConflictException('Клиент уже зафиксирован другим брокером');
    const next = { handle: () => throwError(() => error) } as CallHandler;

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(error);
    expect(opsAlerts.sendSafely).not.toHaveBeenCalled();
  });
});
