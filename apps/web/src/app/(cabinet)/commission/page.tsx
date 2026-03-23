import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Комиссии | ST Michael Broker Platform',
  description: 'Расчет и управление комиссиями',
}

export default function CommissionPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Комиссии</h1>
        <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors">
          Рассчитать комиссию
        </button>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <div className="text-center py-12">
          <p className="text-gray-400">Калькулятор комиссий будет реализован в следующем шаге</p>
        </div>
      </div>
    </div>
  )
}