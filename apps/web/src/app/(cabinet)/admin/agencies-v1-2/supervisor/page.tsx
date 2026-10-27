"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiDownload } from "@/lib/api";
import { getLoyaltyCallResultOptions } from "@/lib/loyalty-base-api";
import {
  type SupervisorFilters,
  type SupervisorReport,
  moscowDay,
  overdueDuration,
  supervisorDate,
  supervisorQuery,
} from "@/lib/agency-supervisor";
import { useAgencyDraftGuard } from "@/lib/use-agency-draft";
import { AgencyDelayReason } from "@/components/loyalty-base/AgencyDelayReason";
import { AgencyCallReview } from "@/components/loyalty-base/AgencyCallReview";
import { LoyaltySavedViews } from "@/components/loyalty-base/LoyaltySavedViews";

const qualityLabels: Record<string, string> = {
  noPhone: "Без телефона",
  noOwner: "Без открытого назначения",
  invalidPhone: "Есть отметка о неверном номере",
  missingNextAction: "Обещание без следующего шага или срока",
  scriptNotCurrent: "Нет актуального скрипта",
};
const emptyFilters = (): SupervisorFilters => ({
  from: moscowDay(),
  to: moscowDay(),
  assigneeId: "",
  campaignId: "",
  agencyId: "",
  agencyType: "",
});
const evidenceLabels: Record<string, string> = {
  ...qualityLabels,
  attemptedAgencies: "Агентства с попыткой",
  assignedAgencies: "Назначенные агентства",
  attempts: "Попытки звонка",
  conversationAgencies: "Агентства с разговором",
  agreements: "Договорённости",
  agreementConversations: "Результаты разговоров",
  tasksDue: "Задачи со сроком в периоде",
  tasksOnTime: "Задачи, выполненные в срок",
  overdue: "Открытые просрочки",
};
const workspaceLink = (id: string) =>
  `/admin/agencies-v1-2/workspace?agencyId=${encodeURIComponent(id)}`;
const resultName = (result: string) =>
  getLoyaltyCallResultOptions("agencies").find((o) => o.code === result)
    ?.label || result;

export default function AgencySupervisorPage() {
  const [filters, setFilters] = useState(emptyFilters),
    [applied, setApplied] = useState(emptyFilters);
  const [data, setData] = useState<SupervisorReport | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [focus, setFocus] = useState("");
  const [qaOnlyUnreviewed, setQaOnlyUnreviewed] = useState(true),
    [qaPage, setQaPage] = useState(0);
  const sequence = useRef(0);
  const guard = useAgencyDraftGuard(data?.currentUserId || "");
  const load = useCallback(async (next: SupervisorFilters) => {
    const seq = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const report = await apiGet<SupervisorReport>(
        `/loyalty-workflow/agencies-v1-2/supervisor?${supervisorQuery(next)}`,
      );
      if (seq !== sequence.current) return;
      setData(report);
      setApplied(next);
      setFocus("");
      setQaPage(0);
    } catch (e) {
      if (seq === sequence.current)
        setError(e instanceof Error ? e.message : "Не удалось получить отчёт");
    } finally {
      if (seq === sequence.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load(emptyFilters());
  }, [load]);
  useEffect(() => {
    if (focus)
      document
        .getElementById("metric-evidence")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);
  const patch = (part: Partial<SupervisorFilters>) =>
    setFilters((old) => ({ ...old, ...part }));
  const canAssign = !!data?.permissions.includes("CALL_ASSIGN");
  const canReview = !!data?.permissions.includes("CALL_REVIEW");
  const qa = data?.qaSample.filter((a) => !qaOnlyUnreviewed || !a.review) || [];
  const exportReport = async () => {
    try {
      const file = await apiDownload(
        `/loyalty-workflow/agencies-v1-2/export?${supervisorQuery(applied)}`,
        {},
      );
      const url = URL.createObjectURL(file.blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выгрузить отчёт");
    }
  };
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">
          Агентства v1/2 · Контроль руководителя
        </h1>
        <div className="flex flex-wrap gap-4">
          <Link className="text-accent" href="/admin/agencies-v1-2/workspace">
            Рабочее место и назначения
          </Link>
          <Link className="text-accent" href="/admin/agencies-v1-2">
            Исходная таблица
          </Link>
        </div>
      </header>
      {!!guard.count && (
        <p role="status">
          Несохранённых форм в этой вкладке: {guard.count}.{" "}
          {guard.memoryOnly
            ? "Хранилище недоступно: не закрывайте страницу до сохранения."
            : "Черновики сохраняются в этой вкладке, но не отправляются в базу автоматически."}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded bg-error/10 p-3">
          {error}.{" "}
          {data
            ? "Остаётся последняя успешная выборка; новый фильтр не применён."
            : "Доступ к отчёту требует права чтения всей базы."}
        </p>
      )}
      <form
        className="card grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void load(filters);
        }}
      >
        <label>
          С
          <input
            aria-label="Начало периода"
            type="date"
            className="input"
            value={filters.from}
            onChange={(e) => patch({ from: e.target.value })}
          />
        </label>
        <label>
          По
          <input
            aria-label="Конец периода"
            type="date"
            className="input"
            value={filters.to}
            onChange={(e) => patch({ to: e.target.value })}
          />
        </label>
        <select
          aria-label="Фильтр сотрудника"
          className="input"
          value={filters.assigneeId}
          onChange={(e) => patch({ assigneeId: e.target.value })}
        >
          <option value="">Все сотрудники</option>
          {data?.operators.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Фильтр кампании"
          className="input"
          value={filters.campaignId}
          onChange={(e) => patch({ campaignId: e.target.value })}
        >
          <option value="">Все кампании</option>
          {data?.filterOptions.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Фильтр агентства"
          className="input"
          value={filters.agencyId}
          onChange={(e) => patch({ agencyId: e.target.value })}
        >
          <option value="">Все агентства</option>
          {data?.filterOptions.agencies.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Фильтр типа агентства"
          className="input"
          value={filters.agencyType}
          onChange={(e) => patch({ agencyType: e.target.value })}
        >
          <option value="">Все типы</option>
          {["АН", "Ключевой", "Агрегатор"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Загрузка…" : "Применить фильтры"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !data}
          onClick={() => void load(applied)}
        >
          Обновить текущий отчёт
        </button>
      </form>
      {data && JSON.stringify(filters) !== JSON.stringify(applied) && (
        <p role="status">
          Параметры изменены, но ещё не применены. Показатели и экспорт
          относятся к последней успешной выборке.
        </p>
      )}
      {data && (
        <>
          <p className="text-sm">
            Применённый период: {applied.from} — {applied.to}, МСК. Сформировано{" "}
            {supervisorDate(data.generatedAt)} МСК. Снимок Google:{" "}
            {supervisorDate(data.source.loadedAt)}
            {data.source.stale
              ? " — устарел, нужна проверка синхронизации"
              : ""}
            . Спорных сопоставлений: {data.source.pendingReviewCount}; строк без
            карточки: {data.source.newCount}.
          </p>
          <LoyaltySavedViews
            base="ours"
            entityType="agencies"
            currentUserId={data.currentUserId}
            currentSnapshot={{
              workspace: "agency-v1-2-supervisor",
              ...applied,
            }}
            canManageShared={data.permissions.includes("REFERENCE_MANAGE")}
            isAdmin={data.role === "ADMIN"}
            onApply={(view) => {
              if (view.workspace !== "agency-v1-2-supervisor") {
                setError("Это представление другого раздела");
                return;
              }
              const next = {
                ...emptyFilters(),
                ...Object.fromEntries(
                  Object.entries(view).filter(
                    ([key, value]) =>
                      key in emptyFilters() && typeof value === "string",
                  ),
                ),
              } as SupervisorFilters;
              setFilters(next);
              void load(next);
            }}
          />
          <nav className="flex flex-wrap gap-3 text-accent">
            <a href="#rates">Показатели</a>
            <a href="#overdue">Просрочки</a>
            <a href="#workload">Нагрузка</a>
            <a href="#quality">Качество данных</a>
            <a href="#manual-qa">Ручная проверка</a>
          </nav>
          {data.permissions.includes("EXPORT") && (
            <button
              className="btn btn-secondary"
              onClick={() => void exportReport()}
            >
              CSV событий применённой выборки
            </button>
          )}
          <section id="rates" className="card space-y-3">
            <h2 className="text-xl font-semibold">
              Показатели и основания расчёта
            </h2>
            <button
              className="btn btn-secondary"
              onClick={() => setFocus("attempts")}
            >
              Попыток за период: {data.metrics.attempts}
            </button>
            <div className="grid gap-3 md:grid-cols-2">
              {data.rates.map((r) => (
                <article
                  key={r.key}
                  className="rounded border border-border p-3"
                >
                  <h3 className="font-semibold">
                    {r.title}: {r.numerator} / {r.denominator} ·{" "}
                    {r.ratio === null
                      ? "нет данных для доли"
                      : `${(r.ratio * 100).toFixed(1)}%`}
                  </h3>
                  <p className="text-sm">{r.explanation}</p>
                  <div className="flex gap-3 text-accent">
                    <button onClick={() => setFocus(r.numeratorKey)}>
                      Числитель ({r.numerator})
                    </button>
                    <button onClick={() => setFocus(r.denominatorKey)}>
                      Знаменатель ({r.denominator})
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <p className="text-sm">
              Исключено: отменённых задач со сроком в периоде —{" "}
              {data.exclusions.cancelledTasksInPeriod}. Задач без срока в
              текущей выборке — {data.exclusions.tasksWithoutDueDate}; их нельзя
              отнести к периоду выполнения. Нулевой знаменатель не означает
              нулевую эффективность.
            </p>
          </section>
          {focus && (
            <section
              id="metric-evidence"
              className="card scroll-mt-20"
              aria-label="Расшифровка показателя"
            >
              <h2 className="font-semibold">
                Исходные события: {evidenceLabels[focus] || focus}
              </h2>
              <button onClick={() => setFocus("")}>Закрыть расшифровку</button>
              {!(data.evidence[focus] || []).length && (
                <p>Нет событий в применённой выборке.</p>
              )}
              {(data.evidence[focus] || []).map((e) => {
                const card = data.cards.find((c) => c.id === e.agencyId),
                  a = card?.attempts.find((r) => r.id === e.eventId),
                  t = card?.tasks.find((r) => r.id === e.eventId);
                return (
                  <div
                    key={`${e.kind}:${e.eventId}`}
                    className="border-b border-border py-2"
                  >
                    <Link
                      className="text-accent"
                      href={workspaceLink(e.agencyId)}
                    >
                      {card?.name || e.agencyId}
                    </Link>
                    <p>
                      {a
                        ? `${resultName(a.result)} · звонок ${supervisorDate(data.attemptDates?.[a.id]?.callOccurredAt || a.occurredAt)} МСК · ${a.comment || "Без комментария"}`
                        : t
                          ? `${t.title} · ${t.status} · ${supervisorDate(t.dueAt)}`
                          : "Уникальное агентство"}
                    </p>
                    <small>{e.eventId}</small>
                  </div>
                );
              })}
            </section>
          )}
          <section id="overdue" className="card space-y-3">
            <h2 className="text-xl font-semibold">
              Открытые просрочки сейчас: {data.overdue.length}
            </h2>
            <p>
              Возраст рассчитан на момент обновления отчёта. Фильтр периода
              относится к результатам звонков и срокам выполнения; этот список
              показывает все открытые просрочки выбранных агентств/сотрудников.
            </p>
            {!data.overdue.length && <p>Открытых просрочек нет.</p>}
            {data.overdue.map((t) => (
              <article key={t.id} className="rounded border border-border p-3">
                <Link className="text-accent" href={workspaceLink(t.agencyId)}>
                  {t.agencyName}
                </Link>
                <p>
                  {t.title} · {t.assignedTo.fullName} · срок{" "}
                  {supervisorDate(t.dueAt)} МСК · просрочено{" "}
                  {overdueDuration(t.overdueMinutes)}
                </p>
                <AgencyDelayReason
                  task={t}
                  scope={data.currentUserId}
                  canEdit={canAssign}
                  onChanged={() => load(applied)}
                />
              </article>
            ))}
          </section>
          <section id="workload" className="card space-y-3">
            <h2 className="text-xl font-semibold">
              Нагрузка и состав текущих назначений
            </h2>
            <p>
              Сравнивайте состав агентств и проблемы контактов, а не только
              число звонков. Автоматического рейтинга сотрудников нет.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {[
                      "Сотрудник",
                      "Назначения сейчас",
                      "Типы агентств",
                      "Без телефона",
                      "Просрочки сейчас",
                      "Попытки за период",
                    ].map((label) => (
                      <th key={label} className="p-2 text-left">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.workload.map((w) => (
                    <tr key={w.id}>
                      <td className="p-2">
                        <button
                          className="text-accent"
                          onClick={() => {
                            const next = { ...applied, assigneeId: w.id };
                            setFilters(next);
                            void load(next);
                          }}
                        >
                          {w.name}
                        </button>
                      </td>
                      <td>{w.open}</td>
                      <td>
                        {Object.entries(w.types)
                          .map(([type, n]) => `${type}: ${n}`)
                          .join("; ") || "Нет текущих назначений"}
                      </td>
                      <td>{w.withoutPhone}</td>
                      <td>{w.overdue}</td>
                      <td>{w.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.workload.length && (
              <p>
                В выборке нет назначений, попыток или просрочек сотрудников.
              </p>
            )}
          </section>
          <section id="quality" className="card space-y-3">
            <h2 className="text-xl font-semibold">Качество данных</h2>
            <div className="flex flex-wrap gap-2">
              {Object.entries(qualityLabels).map(([key, label]) => (
                <button
                  key={key}
                  className="btn btn-secondary"
                  onClick={() => setFocus(key)}
                >
                  {label}: {data.quality[key]?.length ?? "нет данных"}
                </button>
              ))}
            </div>
            <p>
              Неверный номер — не исправленная запись результата в истории;
              наличие нового контакта само по себе не исправляет прошлый
              результат.
            </p>
          </section>
          <section id="manual-qa" className="card space-y-3">
            <h2 className="text-xl font-semibold">
              Выборочная ручная проверка
            </h2>
            <label>
              <input
                type="checkbox"
                checked={qaOnlyUnreviewed}
                onChange={(e) => {
                  setQaOnlyUnreviewed(e.target.checked);
                  setQaPage(0);
                }}
              />{" "}
              Только без проверки текущей версии результата
            </label>
            <p>
              Записей: {qa.length}. Отметка оператора не заменяет аудиозапись;
              если подтверждения нет, выбирайте «Недостаточно данных». После
              сохранения обновите отчёт для пересчёта выборки.
            </p>
            {qa.slice(qaPage * 20, qaPage * 20 + 20).map((a) => (
              <article
                key={a.attemptId}
                className="rounded border border-border p-3"
              >
                <Link href={workspaceLink(a.agencyId)} className="text-accent">
                  {a.agencyName}
                </Link>
                <p>
                  {a.operator?.fullName || "Автор не указан"} ·{" "}
                  {supervisorDate(a.occurredAt)} МСК · {resultName(a.result)}
                </p>
                <p className="whitespace-pre-wrap">{a.comment}</p>
                {a.review && (
                  <p>
                    Проверено: {a.review.reviewer.fullName} · версия{" "}
                    {a.review.version}
                  </p>
                )}
                <AgencyCallReview
                  draftScope={data.currentUserId}
                  agencyId={a.agencyId}
                  attemptId={a.attemptId}
                  canWrite={canReview}
                  superseded={false}
                />
              </article>
            ))}
            <div className="flex gap-2">
              <button
                className="btn btn-secondary"
                disabled={!qaPage}
                onClick={() => setQaPage((n) => n - 1)}
              >
                Предыдущие записи
              </button>
              <button
                className="btn btn-secondary"
                disabled={(qaPage + 1) * 20 >= qa.length}
                onClick={() => setQaPage((n) => n + 1)}
              >
                Следующие записи
              </button>
            </div>
          </section>
          <p className="text-sm text-text-muted">
            Технические соединения Mango, записи разговоров и подтверждённые
            CRM-сделки не входят в эти ручные показатели. Их отсутствие не
            отображается как нулевой результат кампании.
          </p>
        </>
      )}
    </div>
  );
}
