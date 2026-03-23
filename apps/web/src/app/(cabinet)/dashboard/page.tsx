export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Дашборд</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="card">
          <h3 className="text-lg font-semibold mb-2">Клиенты</h3>
          <p className="text-2xl font-bold text-accent">0</p>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-2">Фиксации</h3>
          <p className="text-2xl font-bold text-accent">0</p>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-2">Сделки</h3>
          <p className="text-2xl font-bold text-accent">0</p>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-2">Комиссия</h3>
          <p className="text-2xl font-bold text-accent">0 ₽</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Недавние клиенты</h3>
          <p className="text-text-muted">Нет данных</p>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Активные сделки</h3>
          <p className="text-text-muted">Нет данных</p>
        </div>
      </div>
    </div>
  );
}