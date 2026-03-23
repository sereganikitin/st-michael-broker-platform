import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Аналитика | ST Michael Broker Platform',
  description: 'Статистика и аналитика работы брокера',
}

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Аналитика</h1>
        <div className="flex gap-2">
          <button className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-2 rounded-lg transition-colors">
            Сегодня
          </button>
          <button className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-2 rounded-lg transition-colors">
            Неделя
          </button>
          <button className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg transition-colors">
            Месяц
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-gray-400 text-sm font-medium">Активные клиенты</h3>
          <p className="text-2xl font-bold text-white mt-2">0</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-gray-400 text-sm font-medium">Сделки в работе</h3>
          <p className="text-2xl font-bold text-white mt-2">0</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-gray-400 text-sm font-medium">Комиссия за месяц</h3>
          <p className="text-2xl font-bold text-white mt-2">₽0</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-gray-400 text-sm font-medium">Показы объектов</h3>
          <p className="text-2xl font-bold text-white mt-2">0</p>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <div className="text-center py-12">
          <p className="text-gray-400">Графики и детальная аналитика будут реализованы в следующем шаге</p>
        </div>
      </div>
    </div>
  )
}