import { CommandContext } from 'grammy'
import { mainKeyboard } from '../keyboards/main'

export async function startCommand(ctx: CommandContext<any>) {
  const telegramId = ctx.from?.id?.toString()

  if (!telegramId) {
    await ctx.reply('Ошибка получения ID пользователя')
    return
  }

  // Проверяем, авторизован ли уже пользователь
  try {
    const broker = await ctx.api.call('getBrokerByTelegramId', telegramId)
    if (broker) {
      ctx.session = { ...ctx.session, broker }
      await ctx.reply('Вы уже авторизованы!', {
        reply_markup: mainKeyboard
      })
      return
    }
  } catch (error) {
    // Пользователь не авторизован, продолжаем
  }

  await ctx.reply(
    'Добро пожаловать в кабинет брокера ST Michael!\\n\\n' +
    'Для авторизации введите ваш номер телефона в формате +7XXXXXXXXXX',
    {
      reply_markup: { force_reply: true }
    }
  )

  // Ожидаем ответ с номером телефона
  const phoneCtx = await ctx.waitFor('message:text')
  const phone = phoneCtx.message.text.trim()

  // Валидация номера телефона
  const phoneRegex = /^\+7\d{10}$/
  if (!phoneRegex.test(phone)) {
    await ctx.reply('Неверный формат номера. Используйте формат +7XXXXXXXXXX')
    return
  }

  try {
    // Отправляем SMS с кодом
    await ctx.api.call('sendSmsOtp', phone)
    await ctx.reply('SMS с кодом отправлено. Введите 4-значный код:')

    // Ожидаем код подтверждения
    const codeCtx = await ctx.waitFor('message:text')
    const code = codeCtx.message.text.trim()

    if (!/^\d{4}$/.test(code)) {
      await ctx.reply('Код должен состоять из 4 цифр')
      return
    }

    // Проверяем код и получаем брокера
    const authResult = await ctx.api.call('verifySmsOtp', phone, code)
    if (!authResult.broker) {
      await ctx.reply('Брокер с таким номером не найден')
      return
    }

    // Связываем Telegram ID с брокером
    await ctx.api.call('updateBrokerTelegramId', authResult.broker.id, telegramId)

    // Сохраняем в сессии
    ctx.session = { ...ctx.session, broker: authResult.broker }

    await ctx.reply(
      `✅ Авторизация успешна!\\n\\nДобро пожаловать, ${authResult.broker.firstName} ${authResult.broker.lastName}`,
      {
        reply_markup: mainKeyboard
      }
    )

  } catch (error) {
    console.error('Auth error:', error)
    await ctx.reply('Ошибка авторизации. Попробуйте позже.')
  }
}