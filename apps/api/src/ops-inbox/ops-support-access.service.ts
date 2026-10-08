import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@st-michael/database';
import { telegramApiBase } from '../common/telegram-api-base';

const STATE_KEY = 'OPS_SUPPORT_ACCESS_STATE';
type KbRole = 'manager' | 'admin' | 'call_center_head';
type AccessUser = { chatId: string; name: string; username?: string; active: boolean; kb: boolean; kbRole: KbRole; plaud: boolean; joinedAt: string };
type AccessState = { users: Record<string, AccessUser>; invites: Record<string, { createdBy: string; createdAt: string; usedBy?: string; usedAt?: string }> };
type TgFrom = { id: number; first_name?: string; last_name?: string; username?: string };
type TgMessage = { message_id: number; chat: { id: number; type: string }; from?: TgFrom; text?: string };
type TgCallback = { id: string; from: TgFrom; message?: { message_id: number; chat: { id: number } }; data?: string };

const ROLE_LABELS: Record<KbRole, string> = {
  manager: 'Менеджер', admin: 'Администратор', call_center_head: 'Руководитель колл-центра',
};

@Injectable()
export class OpsSupportAccessService {
  private readonly logger = new Logger(OpsSupportAccessService.name);
  private mutation: Promise<unknown> = Promise.resolve();
  private botUsername?: string;

  constructor(@Inject('PrismaClient') private readonly prisma: PrismaClient, private readonly config: ConfigService) {}

  private token(): string | undefined {
    return this.config.get<string>('OPS_TELEGRAM_BOT_TOKEN')?.trim() || this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() || undefined;
  }
  private adminIds(): Set<string> {
    const raw = this.config.get<string>('OPS_SUPPORT_ADMIN_IDS') || this.config.get<string>('OPS_ALERT_CHAT_IDS') || this.config.get<string>('OPS_ALERT_CHAT_ID') || '';
    return new Set(raw.split(/[\s,;]+/).map((v) => v.trim()).filter((v) => /^\d+$/.test(v)));
  }
  private isAdmin(id: string): boolean { return this.adminIds().has(id); }
  private name(from?: TgFrom): string { return [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() || from?.username || 'Коллега'; }

  private async load(): Promise<AccessState> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: STATE_KEY } });
    if (!row?.value) return { users: {}, invites: {} };
    try {
      const parsed = JSON.parse(row.value);
      return { users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {}, invites: parsed?.invites && typeof parsed.invites === 'object' ? parsed.invites : {} };
    } catch {
      this.logger.warn(`${STATE_KEY}: invalid JSON; using empty state`);
      return { users: {}, invites: {} };
    }
  }
  private async save(state: AccessState): Promise<void> {
    const value = JSON.stringify(state);
    await this.prisma.systemSetting.upsert({ where: { key: STATE_KEY }, update: { value, updatedBy: 'ops-support-bot' }, create: { key: STATE_KEY, value, updatedBy: 'ops-support-bot' } });
  }
  private async mutate<T>(fn: (state: AccessState) => Promise<T> | T): Promise<T> {
    const run = this.mutation.then(async () => { const state = await this.load(); const result = await fn(state); await this.save(state); return result; });
    this.mutation = run.catch(() => undefined);
    return run;
  }
  private async api(method: string, body: Record<string, unknown>): Promise<any> {
    const token = this.token();
    if (!token) throw new Error('OPS Telegram bot token is missing');
    const response = await fetch(`${telegramApiBase()}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(`Telegram ${method}: HTTP ${response.status}`);
    return payload.result;
  }
  private send(chatId: string, text: string, replyMarkup?: Record<string, unknown>): Promise<any> {
    return this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }
  private settingsKeyboard(user: AccessUser) {
    return { inline_keyboard: [
      [{ text: `${user.kb ? '✅' : '▫️'} Статус КБ`, callback_data: 'ops:toggle:kb' }],
      ...(user.kb ? [[{ text: `Роль КБ: ${ROLE_LABELS[user.kbRole]}`, callback_data: 'ops:roles' }]] : []),
      [{ text: `${user.plaud ? '✅' : '▫️'} Статус PLAUD`, callback_data: 'ops:toggle:plaud' }],
      [{ text: 'Готово', callback_data: 'ops:menu' }],
    ] };
  }
  private menuKeyboard(user: AccessUser) {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (user.kb) rows.push([{ text: `🏢 Статус КБ · ${ROLE_LABELS[user.kbRole]}`, callback_data: 'ops:status:kb' }]);
    if (user.plaud) rows.push([{ text: '🎙 Статус PLAUD', callback_data: 'ops:status:plaud' }]);
    rows.push([{ text: '⚙️ Настроить разделы', callback_data: 'ops:settings' }]);
    return { inline_keyboard: rows };
  }
  private async ensureUser(chatId: string, from?: TgFrom): Promise<AccessUser | null> {
    const state = await this.load();
    if (state.users[chatId]?.active) return state.users[chatId];
    if (!this.isAdmin(chatId)) return null;
    return this.mutate((draft) => {
      const user: AccessUser = { chatId, name: this.name(from), username: from?.username, active: true, kb: true, kbRole: 'admin', plaud: true, joinedAt: new Date().toISOString() };
      draft.users[chatId] = user; return user;
    });
  }
  private async username(): Promise<string> {
    if (this.botUsername) return this.botUsername;
    const me = await this.api('getMe', {});
    this.botUsername = String(me?.username || '');
    if (!this.botUsername) throw new Error('Telegram bot has no username');
    return this.botUsername;
  }

  async handleMessage(message: TgMessage): Promise<boolean> {
    const text = String(message.text || '').trim();
    if (!text.startsWith('/')) return false;
    const chatId = String(message.chat.id);
    const [raw, payload] = text.split(/\s+/, 2);
    const command = raw.split('@')[0].toLowerCase();
    if (command === '/start' && payload?.startsWith('invite_')) {
      const inviteToken = payload.slice(7);
      const user = await this.mutate((state) => {
        const invite = state.invites[inviteToken];
        if (!invite || invite.usedBy) return null;
        const added: AccessUser = { chatId, name: this.name(message.from), username: message.from?.username, active: true, kb: false, kbRole: 'manager', plaud: true, joinedAt: new Date().toISOString() };
        invite.usedBy = chatId; invite.usedAt = new Date().toISOString(); state.users[chatId] = added; return added;
      });
      if (!user) await this.send(chatId, 'Приглашение недействительно или уже использовано. Попросите новую ссылку.');
      else await this.send(chatId, '✅ Доступ выдан. Выберите разделы, которые хотите видеть:', this.settingsKeyboard(user));
      return true;
    }
    const user = await this.ensureUser(chatId, message.from);
    if (command === '/invite') {
      if (!this.isAdmin(chatId)) { await this.send(chatId, 'Создавать приглашения может только администратор бота.'); return true; }
      const inviteToken = randomBytes(12).toString('base64url');
      await this.mutate((state) => { state.invites[inviteToken] = { createdBy: chatId, createdAt: new Date().toISOString() }; });
      const link = `https://t.me/${await this.username()}?start=invite_${inviteToken}`;
      await this.send(chatId, `Персональная одноразовая ссылка для коллеги:\n<code>${link}</code>\n\nПосле входа коллега сам выберет доступные разделы.`);
      return true;
    }
    if (['/start', '/menu', '/settings'].includes(command)) {
      if (!user) { await this.send(chatId, 'Доступ только по приглашению. Попросите администратора прислать персональную ссылку.'); return true; }
      if (command === '/settings') await this.send(chatId, 'Какие разделы показывать?', this.settingsKeyboard(user));
      else await this.send(chatId, `Здравствуйте, ${user.name}. Выберите раздел:`, this.menuKeyboard(user));
      return true;
    }
    return false;
  }

  async handleCallback(query: TgCallback): Promise<boolean> {
    const data = String(query.data || '');
    if (!data.startsWith('ops:') || !query.message) return false;
    const chatId = String(query.message.chat.id);
    let user = (await this.load()).users[chatId];
    if (!user?.active) { await this.api('answerCallbackQuery', { callback_query_id: query.id, text: 'Доступ не найден', show_alert: true }); return true; }
    if (data === 'ops:toggle:kb' || data === 'ops:toggle:plaud') {
      user = await this.mutate((state) => { const current = state.users[chatId]; if (data.endsWith(':kb')) current.kb = !current.kb; else current.plaud = !current.plaud; return current; });
      await this.send(chatId, 'Настройки обновлены:', this.settingsKeyboard(user));
    } else if (data === 'ops:roles') {
      await this.send(chatId, 'Выберите, от чьего лица показывать статус КБ:', { inline_keyboard: [
        [{ text: 'Менеджер', callback_data: 'ops:role:manager' }], [{ text: 'Администратор', callback_data: 'ops:role:admin' }], [{ text: 'Руководитель колл-центра', callback_data: 'ops:role:call_center_head' }],
      ] });
    } else if (data.startsWith('ops:role:')) {
      const role = data.slice(9) as KbRole;
      if (role in ROLE_LABELS) { user = await this.mutate((state) => { state.users[chatId].kbRole = role; return state.users[chatId]; }); await this.send(chatId, `Роль КБ изменена: <b>${ROLE_LABELS[user.kbRole]}</b>.`, this.menuKeyboard(user)); }
    } else if (data === 'ops:settings') await this.send(chatId, 'Какие разделы показывать?', this.settingsKeyboard(user));
    else if (data === 'ops:menu') await this.send(chatId, 'Выберите раздел:', this.menuKeyboard(user));
    else if (data === 'ops:status:kb') await this.send(chatId, `🟢 <b>КБ работает</b>\nПредставление: ${ROLE_LABELS[user.kbRole]}\n\nПри появлении технической ошибки напишите её сообщением в этот чат.`);
    else if (data === 'ops:status:plaud') await this.send(chatId, '🟢 <b>Мониторинг PLAUD работает</b>\nПроверка названий встреч выполняется ежедневно в 09:00 МСК.');
    await this.api('answerCallbackQuery', { callback_query_id: query.id });
    return true;
  }
}
