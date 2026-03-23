import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Каталог | ST Michael Broker Platform',
  description: 'Каталог объектов недвижимости',
}

export default function CatalogPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Каталог</h1>
        <div className="flex gap-2">
          <button className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-lg transition-colors">
            Фильтры
          </button>
          <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors">
            Добавить объект
          </button>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <div className="text-center py-12">
          <p className="text-gray-400">Каталог объектов будет реализован в следующем шаге</p>
        </div>
      </div>
    </div>
  )
}