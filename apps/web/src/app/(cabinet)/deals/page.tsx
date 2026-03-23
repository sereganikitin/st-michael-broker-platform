import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Сделки | ST Michael Broker Platform',
  description: 'Управление сделками',
}

export default function DealsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Сделки</h1>
        <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors">
          Создать сделку
        </button>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <div className="text-center py-12">
          <p className="text-gray-400">Управление сделками будет реализовано в следующем шаге</p>
        </div>
      </div>
    </div>
  )
}