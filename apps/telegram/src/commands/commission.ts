import { CommandContext } from 'grammy'
import { apiService } from '../services/api'

export async function commissionCommand(ctx: CommandContext<any>) {
  const broker = ctx.session?.broker

  if (!broker) {
    await ctx.reply('Вы не авторизованы')
    return
  }

  try {
    const commission = await apiService.getBrokerCommission(broker.id)

    let message = `📊 *Ваша комиссия*\n\n`
    message += `Уровень: ${commission.level}\n`
    message += `Ставка: ${commission.rate}%\n`
    message += `Заработано: ₽${commission.earned.toLocaleString()}\n`

    if (commission.nextLevel && commission.progress !== undefined) {
      message += `\nСледующий уровень: ${commission.nextLevel}\n`
      message += `Прогресс: ${commission.progress}%`
    }

    await ctx.reply(message, { parse_mode: 'Markdown' })
  } catch (error) {
    console.error('Commission command error:', error)
    await ctx.reply('Ошибка получения данных о комиссии')
  }
}