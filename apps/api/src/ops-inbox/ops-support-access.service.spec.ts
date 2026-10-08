import { OpsSupportAccessService } from './ops-support-access.service';

describe('OpsSupportAccessService', () => {
  let value = '';
  let sent: any[];
  let service: OpsSupportAccessService;

  beforeEach(() => {
    value = '';
    sent = [];
    const prisma = {
      systemSetting: {
        findUnique: jest.fn(async () => value ? { value } : null),
        upsert: jest.fn(async ({ update, create }: any) => { value = (update || create).value; }),
      },
    };
    const config = { get: jest.fn((key: string) => ({ OPS_TELEGRAM_BOT_TOKEN: 'bot-token', OPS_ALERT_CHAT_IDS: '100' } as any)[key]) };
    global.fetch = jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: body }) } as any;
    }) as any;
    service = new OpsSupportAccessService(prisma as any, config as any);
  });

  it('admits configured administrator and shows both sections', async () => {
    expect(await service.handleMessage({ message_id: 1, chat: { id: 100, type: 'private' }, from: { id: 100, first_name: 'Михаил' }, text: '/start' })).toBe(true);
    expect(sent[0].reply_markup.inline_keyboard.flat().map((button: any) => button.text).join(' ')).toContain('Статус КБ');
    expect(sent[0].reply_markup.inline_keyboard.flat().map((button: any) => button.text).join(' ')).toContain('Статус PLAUD');
  });

  it('rejects a user without an invitation', async () => {
    await service.handleMessage({ message_id: 1, chat: { id: 200, type: 'private' }, from: { id: 200 }, text: '/start' });
    expect(sent[0].text).toContain('Доступ только по приглашению');
  });

  it('lets an invited colleague choose the call-center-head KB view', async () => {
    value = JSON.stringify({ users: {}, invites: { abc: { createdBy: '100', createdAt: new Date().toISOString() } } });
    await service.handleMessage({ message_id: 1, chat: { id: 200, type: 'private' }, from: { id: 200, first_name: 'Анна' }, text: '/start invite_abc' });
    await service.handleCallback({ id: 'q1', from: { id: 200 }, message: { message_id: 2, chat: { id: 200 } }, data: 'ops:toggle:kb' });
    await service.handleCallback({ id: 'q2', from: { id: 200 }, message: { message_id: 3, chat: { id: 200 } }, data: 'ops:role:call_center_head' });
    const state = JSON.parse(value);
    expect(state.users['200']).toMatchObject({ active: true, kb: true, kbRole: 'call_center_head', plaud: true });
  });
});
