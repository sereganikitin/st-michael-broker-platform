"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiPatch, apiPost, apiDownload } from "@/lib/api";
import { contactDateFromInput } from "@/lib/moscow-contact-date";
import {
  agencyQueueContact,
  restoredAgencyFilters,
  sourcePriority,
  AGENCY_QUEUE_FIELDS,
  restoredQueueFields,
  type AgencyQueueField,
} from "@/lib/agency-workspace-view";
import {
  getLoyaltyCallResultOptions,
  type LoyaltyCallResult,
} from "@/lib/loyalty-base-api";
import {
  getLoyaltyOperators,
  submitLoyaltyCall,
  type LoyaltyOperator,
} from "@/lib/loyalty-workflow-api";
import { LoyaltyCampaignDashboard } from "@/components/loyalty-base/LoyaltyCampaignDashboard";
import { LoyaltySavedViews } from "@/components/loyalty-base/LoyaltySavedViews";
import { AgencyCallCorrection } from "@/components/loyalty-base/AgencyCallCorrection";
import { AgencyCallReview } from "@/components/loyalty-base/AgencyCallReview";
import { useAgencyDraft, useAgencyDraftGuard } from "@/lib/use-agency-draft";

import {
  AgencyCallContacts,
  type AgencyCallContact,
} from "@/components/loyalty-base/AgencyCallContacts";

type Assignment = {
  claimed: boolean;
  id: string;
  version: number;
  status: string;
  assignedToId: string;
  assignedAt: string;
  campaign: { id: string; name: string; status: string };
  assignedTo: { id: string; fullName: string };
};
type Attempt = {
  id: string;
  assignmentId: string;
  result: string;
  comment: string;
  nextStep: string;
  nextActionAt: string;
  occurredAt: string;
  correctsAttemptId: string | null;
  correctionReason: string | null;
  operator: { id: string; fullName: string };
};
type Task = {
  kind: string;
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  version: number;
  assignedToId: string;
  completedAt: string | null;
  assignedTo: { fullName: string };
};
type Card = {
  callContacts: AgencyCallContact[];
  callContactsVersion: number;
  id: string;
  name: string;
  type: string;
  phone: string | null;
  email: string | null;
  updatedAt: string;
  doNotCall: boolean;
  callControlVersion: number;
  callControlReason: string | null;
  periods: Array<{
    tab: string;
    row: number;
    baselineRub: string;
    addedRub: string;
    totalRub: string;
    fields: Array<{ label: string; value: string }>;
  }>;
  assignments: Assignment[];
  attempts: Attempt[];
  contextAttempts?: Attempt[];
  tasks: Task[];
};
type Data = {
  quality?: Record<string, string[]>;
  workload?: Array<{ id: string; name: string; open: number; overdue: number }>;
  role: string;
  filterOptions?: {
    agencies: Array<{ id: string; name: string }>;
    campaigns: Array<{ id: string; name: string }>;
  };
  cards: Card[];
  currentUserId: string;
  permissions: string[];
  script: {
    version: number;
    text: string;
    owner: string;
    validUntil: string | null;
    current: boolean;
  };
  metrics: {
    coverage?: { numerator: number; denominator: number; ratio: number | null };
    contact?: { numerator: number; denominator: number; ratio: number | null };
    agreementRate?: { numerator: number; denominator: number };
    assignedAgencies: number;
    attemptedAgencies: number;
    attempts: number;
    conversationAgencies: number;
    agreements: number;
    tasksDue: number;
    tasksOnTime: number;
    overdue: number;
    evidence: Record<
      string,
      Array<{ agencyId: string; eventId: string; kind: string }>
    >;
  };
  source: {
    sourceHash: string;
    loadedAt: string;
    stale: boolean;
    reviewCount: number | null;
    pendingReviewCount?: number | null;
    newCount?: number | null;
  };
  period: { from: string; to: string };
};
type Draft = {
  kind: string;
  result: LoyaltyCallResult | "";
  comment: string;
  nextStep: string;
  when: string;
};
const blank = (): Draft => ({
  kind: "",
  result: "",
  comment: "",
  nextStep: "",
  when: "",
});
const moscow = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value))
    : "Не указан";
const options = [
  ...getLoyaltyCallResultOptions("agencies"),
  { code: "INFORMED", label: "Разговор состоялся" },
  { code: "INVALID_PHONE", label: "Неверный номер" },
  { code: "DO_NOT_CALL", label: "Просьба не звонить" },
];
const resultLabel = (value: string) =>
  options.find((o) => o.code === value)?.label || value;
const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
    new Date(),
  );
const active = (card: Card) =>
  card.assignments.find(
    (a) =>
      ["PENDING", "IN_PROGRESS"].includes(a.status) &&
      a.campaign.status === "ACTIVE",
  );
const historyFor = (card: Card) => card.contextAttempts || card.attempts;
const effectiveAttempts = (card: Card) => {
  const superseded = new Set(historyFor(card).map((a) => a.correctsAttemptId));
  return historyFor(card).filter((a) => !superseded.has(a.id));
};

export default function AgencyCallWorkspace() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("queue");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [queueFields, setQueueFields] = useState<AgencyQueueField[]>([
    ...AGENCY_QUEUE_FIELDS,
  ]);
  const draftScope = data?.currentUserId || "";
  useEffect(() => {
    if (!draftScope) return;
    try {
      const raw = localStorage.getItem(`agency-queue-fields:${draftScope}`);
      setQueueFields(restoredQueueFields(raw ? JSON.parse(raw) : undefined));
    } catch {
      setQueueFields([...AGENCY_QUEUE_FIELDS]);
    }
  }, [draftScope]);
  const updateQueueFields = (fields: unknown) => {
    const value = restoredQueueFields(fields);
    setQueueFields(value);
    if (draftScope)
      try {
        localStorage.setItem(
          `agency-queue-fields:${draftScope}`,
          JSON.stringify(value),
        );
      } catch {
        setError("Набор полей изменён, но браузер не разрешил сохранить его");
      }
  };
  const { value: drafts, setValue: setDrafts } = useAgencyDraft<
    Record<string, Draft>
  >(draftScope, "call-results", {});
  const draftGuard = useAgencyDraftGuard(draftScope);
  const [checked, setChecked] = useState<string[]>([]);
  const [operators, setOperators] = useState<LoyaltyOperator[]>([]);
  const [assignee, setAssignee] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [dashboard, setDashboard] = useState(false);
  const [claims, setClaims] = useState<
    Record<string, { sessionId: string; version: number }>
  >({});
  const [reportFocus, setReportFocus] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterCampaign, setFilterCampaign] = useState("");
  const [filterAgency, setFilterAgency] = useState("");
  const [filterType, setFilterType] = useState("");
  const loadSequence = useRef(0);
  const localClaimReleases = useRef<Record<string, () => void>>({});
  useEffect(
    () => () => {
      Object.values(localClaimReleases.current).forEach((release) => release());
    },
    [],
  );
  const {
    value: scriptDraft,
    setValue: setScriptDraft,
    reset: resetScriptDraft,
  } = useAgencyDraft(draftScope, "script", {
    text: "",
    owner: "",
    until: "",
    version: null as number | null,
  });
  const {
    text: scriptText,
    owner: scriptOwner,
    until: scriptUntil,
  } = scriptDraft;
  const setScriptText = (text: string) =>
    setScriptDraft((old) => ({
      ...old,
      text,
      version: old.version ?? data?.script.version ?? 0,
    }));
  const setScriptOwner = (owner: string) =>
    setScriptDraft((old) => ({
      ...old,
      owner,
      version: old.version ?? data?.script.version ?? 0,
    }));
  const setScriptUntil = (until: string) =>
    setScriptDraft((old) => ({
      ...old,
      until,
      version: old.version ?? data?.script.version ?? 0,
    }));
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(() => today());
  const pilotSubmission = useRef({ signature: "", id: "" });
  const submissions = useRef<Record<string, { signature: string; id: string }>>(
    {},
  );
  const canAssign =
    !!data?.permissions.includes("CALL_ASSIGN") &&
    !!data?.permissions.includes("READ_ALL");
  const canManage =
    !!data?.permissions.includes("REFERENCE_MANAGE") &&
    !!data?.permissions.includes("READ_ALL");

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setBusy(true);
    setError("");
    try {
      const end = new Date(`${to}T00:00:00+03:00`);
      end.setTime(end.getTime() + 86400000);
      const query = new URLSearchParams({
        from: `${from}T00:00:00+03:00`,
        to: end.toISOString(),
      });
      if (filterAssignee) query.set("assigneeId", filterAssignee);
      if (filterCampaign) query.set("campaignId", filterCampaign);
      if (filterAgency) query.set("agencyId", filterAgency);
      if (filterType) query.set("agencyType", filterType);
      const result = await apiGet<Data>(
        `/loyalty-workflow/agencies-v1-2?${query}`,
      );
      if (sequence !== loadSequence.current) return;
      setData(result);
      if (
        result.permissions.includes("READ_ALL") &&
        result.permissions.includes("CALL_ASSIGN")
      )
        setOperators(await getLoyaltyOperators());
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      setError(
        e instanceof Error ? e.message : "Не удалось загрузить рабочее место",
      );
    } finally {
      if (sequence === loadSequence.current) setBusy(false);
    }
  }, [from, to, filterAssignee, filterCampaign, filterAgency, filterType]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("agencyId");
    if (
      id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      setSelected(id);
      setFilterAgency(id);
      setView("all");
    }
  }, []);

  const cards = (data?.cards || []).filter((card) => {
    if (
      !`${card.name} ${card.type}`.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    const openTasks = card.tasks.filter((t) => t.status === "OPEN");
    const attempts = effectiveAttempts(card);
    if (view === "queue")
      return active(card)?.assignedToId === data?.currentUserId;
    if (view === "today")
      return openTasks.some(
        (t) =>
          t.dueAt &&
          new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Europe/Moscow",
          }).format(new Date(t.dueAt)) === today(),
      );
    if (view === "overdue")
      return openTasks.some((t) => t.dueAt && new Date(t.dueAt) < new Date());
    if (view === "new") return !!active(card) && !historyFor(card).length;
    if (view === "callback")
      return attempts.some((a) => a.result === "CALLBACK");
    if (view === "no-phone")
      return (
        (!card.phone &&
          !(card.callContacts || []).some(
            (c) => !c.archived && (c.phone || c.alternatePhone),
          )) ||
        attempts.some((a) => a.result === "INVALID_PHONE")
      );
    if (view === "attempts")
      return attempts.some(
        (a) =>
          new Date(a.occurredAt) >= new Date(data!.period.from) &&
          new Date(a.occurredAt) < new Date(data!.period.to),
      );
    return true;
  });
  const card = cards.find((c) => c.id === selected) || cards[0];
  const assignment = card && active(card);
  const draft = card ? drafts[card.id] || blank() : blank();
  const eligible =
    !!assignment &&
    !!data?.permissions.includes("CALL_EXECUTE") &&
    assignment.assignedToId === data.currentUserId &&
    !card?.doNotCall;
  const editable =
    eligible &&
    !!assignment &&
    assignment.claimed &&
    claims[assignment.id]?.version === assignment.version;
  const patch = (part: Partial<Draft>) =>
    card &&
    setDrafts((current) => {
      const next = {
        ...current,
        [card.id]: { ...(current[card.id] || blank()), ...part },
      };
      if (!Object.values(next[card.id]).some(Boolean)) delete next[card.id];
      return next;
    });
  const applyView = (snapshot: Record<string, unknown>) => {
    if (snapshot.workspace !== "agency-v1-2") {
      setError("Это представление другого раздела");
      return;
    }
    updateQueueFields(snapshot.queueFields);
    if (
      [
        "queue",
        "today",
        "overdue",
        "new",
        "callback",
        "no-phone",
        "all",
      ].includes(String(snapshot.view))
    )
      setView(String(snapshot.view));
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.from)))
      setFrom(String(snapshot.from));
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.to)))
      setTo(String(snapshot.to));
    if (data?.permissions.includes("READ_ALL")) {
      setFilterAssignee(
        typeof snapshot.assignee === "string" ? snapshot.assignee : "",
      );
      setFilterCampaign(
        typeof snapshot.campaign === "string" ? snapshot.campaign : "",
      );
      const restored = restoredAgencyFilters(snapshot);
      setFilterAgency(restored.agency);
      setFilterType(restored.agencyType);
    }
  };
  const viewSnapshot = {
    workspace: "agency-v1-2",
    view,
    from,
    to,
    assignee: filterAssignee,
    campaign: filterCampaign,
    agency: filterAgency,
    agencyType: filterType,
    queueFields,
  };
  const action = async (run: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
      setNotice(message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  };
  const claim = async (target: Assignment) => {
    const acquire = async () => {
      const key = `agency-work-session:${target.id}`;
      const sessionId = sessionStorage.getItem(key) || crypto.randomUUID();
      sessionStorage.setItem(key, sessionId);
      const result = await apiPost<{ version: number }>(
        `/loyalty-workflow/agencies-v1-2/assignments/${target.id}/claim`,
        { expectedVersion: target.version, workSessionId: sessionId },
      );
      setClaims((current) => ({
        ...current,
        [target.id]: { sessionId, version: result.version },
      }));
    };
    if (!navigator.locks || localClaimReleases.current[target.id])
      return acquire();
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(
          `agency-call:${target.id}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(new Error("Карточка уже открыта в другой вкладке"));
              return;
            }
            try {
              await acquire();
              const released = new Promise<void>((done) => {
                localClaimReleases.current[target.id] = done;
              });
              resolve();
              await released;
              delete localClaimReleases.current[target.id];
            } catch (reason) {
              reject(reason);
            }
          },
        )
        .catch(reject);
    });
  };
  const save = async () => {
    if (!assignment || !card || !draft.result) return;
    const payload = {
      workSessionId: claims[assignment.id]?.sessionId,
      assignmentId: assignment.id,
      expectedVersion: assignment.version,
      result: draft.result,
      comment: draft.comment.trim(),
      nextStep: draft.nextStep.trim() || undefined,
      nextActionKind: draft.nextStep.trim()
        ? draft.kind || undefined
        : undefined,
      nextActionAt: contactDateFromInput(draft.when) || undefined,
    };
    const signature = JSON.stringify(payload);
    const old = submissions.current[assignment.id];
    const submissionId =
      old?.signature === signature ? old.id : crypto.randomUUID();
    submissions.current[assignment.id] = { signature, id: submissionId };
    await action(async () => {
      await submitLoyaltyCall({ ...payload, submissionId });
      localClaimReleases.current[assignment.id]?.();
      setDrafts((current) => {
        const next = { ...current };
        delete next[card.id];
        return next;
      });
      setSelected(cards.find((c) => c.id !== card.id)?.id || "");
    }, "Результат сохранён. Выполнение обещанных задач отмечается отдельно.");
  };

  return (
    <div className="space-y-5">
      {!!draftGuard.count && (
        <div
          role="status"
          className="rounded border border-warning p-3 text-sm"
        >
          Несохранённых форм: {draftGuard.count}.{" "}
          {draftGuard.memoryOnly
            ? "Хранилище вкладки недоступно: не закрывайте страницу, пока не сохраните данные."
            : "Черновики сохранены только в этой вкладке и восстановятся при возврате. В рабочую базу они не отправлены."}
          <button
            type="button"
            className="ml-3 text-accent"
            onClick={() => {
              if (
                window.confirm(
                  "Удалить все несохранённые черновики этого пользователя в текущей вкладке? Сохранённые данные не изменятся.",
                )
              )
                draftGuard.discardAll();
            }}
          >
            Удалить все черновики вкладки
          </button>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {data?.permissions.includes("READ_ALL") && (
            <div className="flex flex-wrap gap-4">
              <Link className="text-accent" href="/admin/agencies-v1-2">
                Исходная таблица
              </Link>
              <Link
                className="text-accent"
                href="/admin/agencies-v1-2/supervisor"
              >
                Экран руководителя
              </Link>
            </div>
          )}
          <h1 className="text-2xl font-semibold">
            Агентства v1/2 · Мой обзвон
          </h1>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void load()}
          >
            Обновить
          </button>
          {canAssign && (
            <button
              className="btn btn-secondary"
              onClick={() => setDashboard(true)}
            >
              Кампании и назначения
            </button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="rounded bg-error/10 p-3 text-error">
          {error} При конфликте обновите данные: черновик остаётся на экране.
          {data &&
            " Показаны последние успешно загруженные данные; новый фильтр при ошибке не считается применённым."}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded bg-success/10 p-3">
          {notice}
        </p>
      )}
      {data && (
        <p className="text-sm text-text-muted">
          Google: проверенный снимок {moscow(data.source.loadedAt)} МСК.{" "}
          {data.source.stale && "Снимок устарел; проверьте синхронизацию."}{" "}
          {data.source.pendingReviewCount != null
            ? `Спорных сопоставлений: ${data.source.pendingReviewCount}; строк без карточки: ${data.source.newCount ?? 0}.`
            : data.source.reviewCount !== null &&
              `Требуют сопоставления: ${data.source.reviewCount}.`}{" "}
          Работа хранится в кабинете.
        </p>
      )}
      {data && !data.script.current && (
        <p className="rounded bg-warning/10 p-3">
          Нет актуального утверждённого скрипта. Условия из исторической таблицы
          не используются для звонка. Руководителю нужно утвердить текст и срок.
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="btn btn-secondary"
          onClick={() => {
            try {
              localStorage.setItem(
                `agency-call-view:${data?.currentUserId}`,
                JSON.stringify(viewSnapshot),
              );
              setNotice("Личный фильтр сохранён в этом браузере");
            } catch {
              setError("Браузер не разрешил сохранить фильтр");
            }
          }}
        >
          Сохранить мой фильтр
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => {
            try {
              const saved = localStorage.getItem(
                `agency-call-view:${data?.currentUserId}`,
              );
              if (saved) applyView(JSON.parse(saved));
            } catch {
              setError("Не удалось восстановить фильтр");
            }
          }}
        >
          Восстановить мой фильтр
        </button>
      </div>
      {data?.permissions.includes("READ_ALL") && (
        <LoyaltySavedViews
          base="ours"
          entityType="agencies"
          currentSnapshot={viewSnapshot}
          currentUserId={data.currentUserId}
          canManageShared={canManage}
          isAdmin={data.role === "ADMIN"}
          onApply={applyView}
        />
      )}
      {data?.permissions.includes("READ_ALL") && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Контроль команды</h2>
          <div className="flex flex-wrap gap-3">
            <label>
              С{" "}
              <input
                aria-label="Начало периода"
                className="input"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              По{" "}
              <input
                aria-label="Конец периода"
                className="input"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          {data?.permissions.includes("READ_ALL") && (
            <section className="flex flex-wrap gap-2">
              <select
                aria-label="Фильтр сотрудника"
                className="input max-w-xs"
                value={filterAssignee}
                onChange={(e) => setFilterAssignee(e.target.value)}
              >
                <option value="">Все сотрудники</option>
                {operators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Фильтр типа агентства"
                className="input max-w-xs"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
              >
                <option value="">Все типы</option>
                {["АН", "Ключевой", "Агрегатор"].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
              <select
                aria-label="Фильтр агентства"
                className="input max-w-xs"
                value={filterAgency}
                onChange={(e) => setFilterAgency(e.target.value)}
              >
                <option value="">Все агентства</option>
                {(data.filterOptions?.agencies || data.cards).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Фильтр кампании"
                className="input max-w-xs"
                value={filterCampaign}
                onChange={(e) => setFilterCampaign(e.target.value)}
              >
                <option value="">Все кампании</option>
                {Array.from(
                  new Map(
                    data.cards.flatMap((c) =>
                      c.assignments.map(
                        (a) => [a.campaign.id, a.campaign.name] as const,
                      ),
                    ),
                  ).entries(),
                ).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              {data.permissions.includes("EXPORT") && (
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    void action(async () => {
                      const end = new Date(`${to}T00:00:00+03:00`);
                      end.setTime(end.getTime() + 86400000);
                      const q = new URLSearchParams({
                        from: `${from}T00:00:00+03:00`,
                        to: end.toISOString(),
                      });
                      if (filterAssignee) q.set("assigneeId", filterAssignee);
                      if (filterCampaign) q.set("campaignId", filterCampaign);
                      if (filterAgency) q.set("agencyId", filterAgency);
                      if (filterType) q.set("agencyType", filterType);
                      const result = await apiDownload(
                        `/loyalty-workflow/agencies-v1-2/export?${q}`,
                        {},
                      );
                      const url = URL.createObjectURL(result.blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = result.filename;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }, "Отчёт событий выгружен")
                  }
                >
                  CSV событий периода
                </button>
              )}
            </section>
          )}
          {reportFocus && data && (
            <section className="card">
              <div className="flex justify-between">
                <h2 className="font-semibold">Исходные события показателя</h2>
                <button onClick={() => setReportFocus("")}>Закрыть</button>
              </div>
              {(data.metrics.evidence?.[reportFocus] || []).map((item) => {
                const target = data.cards.find((c) => c.id === item.agencyId);
                const attempt = target?.attempts.find(
                  (a) => a.id === item.eventId,
                );
                const task = target?.tasks.find((t) => t.id === item.eventId);
                return (
                  <div
                    key={item.eventId}
                    className="border-b border-border py-2"
                  >
                    <button
                      className="text-accent"
                      onClick={() => {
                        setView("all");
                        setSearch("");
                        setSelected(item.agencyId);
                      }}
                    >
                      {target?.name}
                    </button>
                    <p>
                      {attempt
                        ? `${resultLabel(attempt.result)} · ${moscow(attempt.occurredAt)} МСК`
                        : task
                          ? `${task.title} · ${moscow(task.dueAt)} МСК · ${task.status}`
                          : "Уникальное агентство"}
                    </p>
                    <small className="break-all">ID: {item.eventId}</small>
                  </div>
                );
              })}
              {!data.metrics.evidence?.[reportFocus]?.length && (
                <p>Событий нет.</p>
              )}
            </section>
          )}
          <div className="flex flex-wrap gap-2">
            {[
              [
                "Агентств назначено",
                data.metrics.assignedAgencies,
                "assignedAgencies",
              ],
              [
                "Агентств с попыткой",
                data.metrics.attemptedAgencies,
                "attemptedAgencies",
              ],
              ["Попыток", data.metrics.attempts, "attempts"],
              [
                "Агентств с разговором",
                data.metrics.conversationAgencies,
                "conversationAgencies",
              ],
              ["Договорённостей", data.metrics.agreements, "agreements"],
              [
                "Задач в срок / со сроком в периоде",
                `${data.metrics.tasksOnTime} / ${data.metrics.tasksDue}`,
                "tasksDue",
              ],
              ["Просрочено задач сейчас", data.metrics.overdue, "overdue"],
            ].map(([label, count, filter]) => (
              <button
                key={label}
                className="btn btn-secondary"
                onClick={() => setReportFocus(String(filter))}
              >
                {label}: {count}
              </button>
            ))}
          </div>
          <p className="text-sm">
            Охват:{" "}
            {data.metrics.coverage
              ? `${data.metrics.coverage.numerator} / ${data.metrics.coverage.denominator}`
              : "—"}
            ; разговор по словам оператора:{" "}
            {data.metrics.contact
              ? `${data.metrics.contact.numerator} / ${data.metrics.contact.denominator}`
              : "—"}
            ; договорённости / разговоры:{" "}
            {data.metrics.agreementRate
              ? `${data.metrics.agreementRate.numerator} / ${data.metrics.agreementRate.denominator}`
              : "—"}
            . Нулевой знаменатель означает «нет данных для доли».
          </p>
          {data.quality && (
            <div className="flex flex-wrap gap-2">
              {Object.entries({
                noPhone: "Нет телефона",
                noOwner: "Нет открытого назначения",
                invalidPhone: "Неверный номер",
                missingNextAction: "Нет следующего шага в результате",
                scriptNotCurrent: "Нет актуального скрипта",
              }).map(([key, label]) => (
                <button
                  key={key}
                  className="btn btn-secondary"
                  onClick={() => setReportFocus(key)}
                >
                  {label}: {data.quality?.[key]?.length || 0}
                </button>
              ))}
            </div>
          )}
          {!!data.workload?.length && (
            <div className="space-y-1">
              <h3 className="font-semibold">Текущая загрузка</h3>
              {data.workload.map((row) => (
                <button
                  key={row.id}
                  className="btn btn-secondary mr-2"
                  onClick={() => setFilterAssignee(row.id)}
                >
                  {row.name}: {row.open} назначений, {row.overdue} просроченных
                  задач
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-text-muted">
            Период — МСК. Попытки считаются отдельно от уникальных агентств.
            Разговор — результат оператора; соединения Mango и сделки amoCRM
            здесь не подтверждаются. Нажмите показатель для списка исходных
            событий. Задачи без срока и отменённые задачи исключены из
            выполнения в срок.
          </p>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        {[
          ["queue", "Мой обзвон"],
          ["today", "Сегодня"],
          ["overdue", "Просрочено"],
          ["new", "Новые"],
          ["callback", "Перезвонить"],
          ["no-phone", "Без телефона"],
          ["all", "Все доступные"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`btn ${view === key ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
        <input
          className="input max-w-xs"
          aria-label="Поиск агентства"
          placeholder="Поиск агентства"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(250px,1fr)_3fr]">
        <aside className="card max-h-[75vh] space-y-2 overflow-auto">
          <div className="sticky top-0 z-10 border-b border-border bg-surface pb-2">
            <h2 className="font-semibold">Очередь агентств ({cards.length})</h2>
            <details>
              <summary className="cursor-pointer text-sm text-accent">
                Поля очереди
              </summary>
              <p className="text-xs">
                Название и запрет звонков показываются всегда. Выбранные поля
                сохраняются в этом браузере и в сохранённых представлениях.
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries({
                  owner: "Ответственный",
                  phone: "Телефон",
                  contact: "Контакт",
                  priority: "Приоритет",
                  reason: "Причина",
                  result: "Последний результат",
                  due: "Срок",
                }).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      aria-label={`Поле очереди: ${label}`}
                      checked={queueFields.includes(key as AgencyQueueField)}
                      onChange={(e) =>
                        updateQueueFields(
                          e.target.checked
                            ? [...queueFields, key]
                            : queueFields.filter((f) => f !== key),
                        )
                      }
                    />{" "}
                    {label}
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="text-xs text-accent mr-3"
                onClick={() => updateQueueFields(AGENCY_QUEUE_FIELDS)}
              >
                Все поля
              </button>
              <button
                type="button"
                className="text-xs text-accent"
                onClick={() => updateQueueFields(["phone", "result", "due"])}
              >
                Краткий набор
              </button>
            </details>
          </div>
          {cards.length === 0 && <p>Нет заданий в этой выборке.</p>}
          {cards.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-2 border-b border-border pb-2"
            >
              {canAssign && (
                <input
                  type="checkbox"
                  aria-label={`Выбрать ${c.name}`}
                  disabled={c.doNotCall || !!active(c)}
                  checked={checked.includes(c.id)}
                  onChange={(e) =>
                    setChecked((prev) =>
                      e.target.checked
                        ? [...prev, c.id]
                        : prev.filter((id) => id !== c.id),
                    )
                  }
                />
              )}
              <button
                className={`text-left ${card?.id === c.id ? "text-accent" : ""}`}
                onClick={() => setSelected(c.id)}
              >
                <b>{c.name}</b>
                {c.doNotCall && (
                  <p className="text-xs text-error">Не звонить</p>
                )}
                {queueFields.includes("owner") && (
                  <p className="text-xs">
                    {active(c)?.assignedTo.fullName ||
                      "Нет активного назначения"}
                  </p>
                )}
                {queueFields.includes("phone") && (
                  <p className="text-xs">{agencyQueueContact(c).phone}</p>
                )}
                {queueFields.includes("contact") && (
                  <p className="text-xs">{agencyQueueContact(c).name}</p>
                )}
                {queueFields.includes("priority") && (
                  <p className="text-xs text-text-muted">
                    Приоритет источника: {sourcePriority(c.periods)}
                  </p>
                )}
                {queueFields.includes("reason") && (
                  <p className="text-xs text-text-muted">
                    Причина:{" "}
                    {active(c)?.campaign.name || "Нет активной кампании"}
                  </p>
                )}
                {queueFields.includes("result") && (
                  <p className="text-xs">
                    Последний результат:{" "}
                    {effectiveAttempts(c)[0]
                      ? resultLabel(effectiveAttempts(c)[0].result)
                      : "Попыток в кабинете нет"}
                  </p>
                )}
                {queueFields.includes("due") &&
                  c.tasks
                    .filter((task) => task.status === "OPEN" && task.dueAt)
                    .sort((left, right) =>
                      left.dueAt!.localeCompare(right.dueAt!),
                    )
                    .slice(0, 1)
                    .map((task) => (
                      <p
                        key={task.id}
                        className={`text-xs ${new Date(task.dueAt!) < new Date() ? "text-error" : "text-text-muted"}`}
                      >
                        {new Date(task.dueAt!) < new Date()
                          ? "Просрочено"
                          : "Следующий шаг"}
                        : {moscow(task.dueAt)} МСК
                      </p>
                    ))}
              </button>
            </div>
          ))}
        </aside>
        {card && (
          <article className="card space-y-4">
            <h2 className="sticky top-16 z-10 bg-surface py-2 text-xl font-semibold">
              {card.name}
            </h2>
            <p>
              {card.type} · {assignment?.campaign.name || "История агентства"}
            </p>
            {eligible && !editable && assignment && (
              <div className="space-y-2">
                <p className="text-sm">
                  Перед звонком закрепите карточку за этим сеансом. Занятую
                  карточку руководитель может переназначить после проверки.
                </p>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void action(
                      () => claim(assignment),
                      "Карточка закреплена за текущим сеансом",
                    )
                  }
                >
                  Взять в работу
                </button>
              </div>
            )}
            <section>
              <h3 className="font-semibold">Контакты кабинета</h3>
              <p>
                {card.phone || "Телефон не указан"} ·{" "}
                {card.email || "Email не указан"}
              </p>
              <p className="text-xs text-text-muted">
                Обновлено {moscow(card.updatedAt)} МСК. Пустые поля не
                дополняются догадками.
              </p>
              {card.phone &&
                card.phone.replace(/\D/g, "").length >= 5 &&
                data?.script.current &&
                !card.doNotCall &&
                editable && (
                  <a
                    className="text-accent"
                    href={`tel:${card.phone.replace(/[^+\d]/g, "")}`}
                  >
                    Позвонить вручную
                  </a>
                )}
              {card.doNotCall && (
                <p className="text-error">
                  Запрет звонков: {card.callControlReason}
                </p>
              )}
            </section>
            <AgencyCallContacts
              draftScope={draftScope}
              key={card.id}
              agencyId={card.id}
              contacts={card.callContacts || []}
              version={card.callContactsVersion}
              canEdit={
                !!data?.permissions.includes("ENTITY_EDIT") &&
                (!!assignment || !!data?.permissions.includes("READ_ALL"))
              }
              canCall={editable && !!data?.script.current}
              onChanged={load}
            />
            <section className="rounded bg-accent/5 p-3">
              <h3 className="font-semibold">
                {data?.script.current
                  ? "Утверждённый скрипт"
                  : "Скрипт недоступен"}
              </h3>
              {data?.script.current && (
                <>
                  <p className="whitespace-pre-wrap">{data.script.text}</p>
                  <p className="text-xs">
                    Владелец: {data.script.owner} · До{" "}
                    {moscow(data.script.validUntil)} МСК
                  </p>
                </>
              )}
            </section>
            <section>
              <h3 className="font-semibold">Открытые задачи</h3>
              {card.tasks
                .filter((t) => t.status === "OPEN")
                .map((t) => (
                  <div className="border-b border-border py-2" key={t.id}>
                    <p>
                      {t.title} · {t.assignedTo.fullName} · {moscow(t.dueAt)}{" "}
                      МСК{" "}
                      {t.dueAt &&
                        new Date(t.dueAt) < new Date() &&
                        "· Просрочено"}
                    </p>
                    {data?.permissions.includes("CALL_EXECUTE") &&
                      t.assignedToId === data.currentUserId && (
                        <button
                          disabled={busy}
                          className="text-accent"
                          onClick={() =>
                            void action(
                              () =>
                                apiPatch(`/loyalty-workflow/tasks/${t.id}`, {
                                  expectedVersion: t.version,
                                  status: "COMPLETED",
                                }),
                              "Задача выполнена",
                            )
                          }
                        >
                          Отметить выполненной
                        </button>
                      )}
                    {data?.permissions.includes("CALL_EXECUTE") &&
                      t.assignedToId === data.currentUserId &&
                      t.kind === "CALL" &&
                      !assignment &&
                      !card.doNotCall && (
                        <button
                          disabled={busy}
                          className="text-accent ml-3"
                          onClick={() =>
                            void action(
                              () =>
                                apiPost(
                                  `/loyalty-workflow/agencies-v1-2/tasks/${t.id}/resume`,
                                  { expectedVersion: t.version },
                                ),
                              "Агентство возвращено в очередь",
                            )
                          }
                        >
                          Начать повторный звонок
                        </button>
                      )}
                  </div>
                ))}
            </section>
            {assignment && (
              <fieldset disabled={!editable || busy} className="grid gap-3">
                <legend className="font-semibold">
                  Результат · ответственный {assignment.assignedTo.fullName}
                </legend>
                <label>
                  Результат
                  <select
                    className="input"
                    value={draft.result}
                    onChange={(e) =>
                      patch({ result: e.target.value as Draft["result"] })
                    }
                  >
                    <option value="">Выберите</option>
                    {options.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Комментарий / договорённость *
                  <textarea
                    aria-label="Комментарий / договорённость"
                    className="input"
                    maxLength={4000}
                    value={draft.comment}
                    onChange={(e) => patch({ comment: e.target.value })}
                  />
                </label>
                <label>
                  Тип следующего действия
                  <select
                    className="input"
                    value={draft.kind}
                    onChange={(e) => patch({ kind: e.target.value })}
                  >
                    <option value="">Выберите тип</option>
                    <option value="CALL">Позвонить</option>
                    <option value="SEND_MATERIALS">Отправить материалы</option>
                    <option value="MEETING">Встреча / тур</option>
                    <option value="OTHER">Другое</option>
                  </select>
                </label>
                <label>
                  Следующий шаг (обязателен для договорённости)
                  <input
                    className="input"
                    maxLength={240}
                    value={draft.nextStep}
                    onChange={(e) => patch({ nextStep: e.target.value })}
                  />
                </label>
                <label>
                  Срок, московское время
                  <input
                    className="input"
                    type="datetime-local"
                    value={draft.when}
                    onChange={(e) => patch({ when: e.target.value })}
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={!draft.result || !draft.comment.trim()}
                  onClick={() => void save()}
                >
                  Сохранить и следующий
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Удалить несохранённый результат этого агентства?",
                      )
                    )
                      setDrafts((old) => {
                        const next = { ...old };
                        delete next[card.id];
                        return next;
                      });
                  }}
                >
                  Отменить черновик результата
                </button>
              </fieldset>
            )}
            <details>
              <summary className="cursor-pointer font-semibold">
                Журнал попыток ({historyFor(card).length}) и задач
              </summary>
              {[...historyFor(card)]
                .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
                .map((a) => (
                  <div key={a.id} className="border-b border-border py-3">
                    <b>{resultLabel(a.result)}</b> · {moscow(a.occurredAt)} МСК
                    · {a.operator.fullName}
                    <p className="whitespace-pre-wrap">{a.comment}</p>
                    {a.nextStep && (
                      <p>
                        {a.nextStep} · {moscow(a.nextActionAt)} МСК
                      </p>
                    )}
                    {a.correctsAttemptId && (
                      <p>
                        Исправление {a.correctsAttemptId}: {a.correctionReason}
                      </p>
                    )}
                    <small>Событие: {a.id}</small>
                    {data?.permissions.includes("READ_ALL") && (
                      <AgencyCallReview
                        draftScope={draftScope}
                        agencyId={card.id}
                        attemptId={a.id}
                        canWrite={data.permissions.includes("CALL_REVIEW")}
                        superseded={historyFor(card).some(
                          (other) => other.correctsAttemptId === a.id,
                        )}
                      />
                    )}
                    {data?.permissions.includes("CALL_EXECUTE") &&
                      (a.operator.id === data.currentUserId ||
                        data.role === "ADMIN") &&
                      a.result !== "DO_NOT_CALL" &&
                      !historyFor(card).some(
                        (other) => other.correctsAttemptId === a.id,
                      ) && (
                        <AgencyCallCorrection
                          draftScope={draftScope}
                          attempt={a}
                          onChanged={load}
                        />
                      )}
                  </div>
                ))}
              {card.tasks.map((t) => (
                <p key={t.id}>
                  {t.title} · {t.status} · {moscow(t.dueAt)} МСК ·{" "}
                  {t.assignedTo.fullName}
                </p>
              ))}
            </details>
            <details>
              <summary className="cursor-pointer font-semibold">
                Исторические периоды Google ({card.periods.length})
              </summary>
              <p className="text-xs">
                Суммы не складываются между периодами и с amoCRM. Скрипты здесь
                — исторические.
              </p>
              {card.periods.map((p) => (
                <details className="py-2" key={`${p.tab}:${p.row}`}>
                  <summary>
                    {p.tab} · строка {p.row} · сумма источника {p.totalRub} ₽
                  </summary>
                  {p.fields.map((f, i) => (
                    <p className="text-sm whitespace-pre-wrap" key={i}>
                      <b>{f.label}:</b> {f.value || "Не заполнено"}
                    </p>
                  ))}
                </details>
              ))}
            </details>
            {canAssign && assignment && (
              <div className="flex gap-2">
                <select
                  className="input"
                  aria-label="Переназначить оператору"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="">Новый ответственный</option>
                  {operators.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-secondary"
                  disabled={busy || !assignee}
                  onClick={() =>
                    void action(
                      () =>
                        apiPatch(
                          `/loyalty-workflow/agencies-v1-2/assignments/${assignment.id}/reassign`,
                          {
                            expectedVersion: assignment.version,
                            assigneeId: assignee,
                          },
                        ),
                      "Назначение и открытые задачи переданы",
                    )
                  }
                >
                  Переназначить
                </button>
              </div>
            )}
            {canAssign && (
              <button
                disabled={busy}
                className="btn btn-secondary"
                onClick={() => {
                  const reason = window.prompt(
                    card.doNotCall
                      ? "Причина снятия запрета звонков"
                      : "Причина запрета звонков",
                  );
                  if (reason?.trim())
                    void action(
                      () =>
                        apiPatch(
                          `/loyalty-workflow/agencies-v1-2/${card.id}/call-control`,
                          {
                            expectedVersion: card.callControlVersion,
                            doNotCall: !card.doNotCall,
                            reason,
                          },
                        ),
                      "Изменение записано в аудит",
                    );
                }}
              >
                {card.doNotCall
                  ? "Снять запрет с причиной"
                  : "Запретить звонки"}
              </button>
            )}
          </article>
        )}
      </div>
      {canAssign && (
        <section className="card space-y-3">
          <h2 className="font-semibold">
            Подготовить пилот · выбрано {checked.length}
          </h2>
          <p className="text-sm">
            Создаётся черновик кампании. Запуск — отдельно в разделе кампаний.
            Исторические периоды не создают дополнительные назначения.
          </p>
          <input
            className="input"
            aria-label="Название пилота"
            placeholder="Название пилота"
            value={campaignName}
            onChange={(e) => setCampaignName(e.target.value)}
          />
          <select
            className="input"
            aria-label="Оператор пилота"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">Выберите оператора</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              !checked.length ||
              !assignee ||
              !campaignName.trim() ||
              !data?.script.current
            }
            onClick={() =>
              void action(async () => {
                const signature = JSON.stringify([
                  campaignName,
                  checked,
                  assignee,
                  data!.source.sourceHash,
                ]);
                if (pilotSubmission.current.signature !== signature)
                  pilotSubmission.current = {
                    signature,
                    id: crypto.randomUUID(),
                  };
                await apiPost("/loyalty-workflow/agencies-v1-2/pilot", {
                  submissionId: pilotSubmission.current.id,
                  name: campaignName,
                  agencyIds: checked,
                  assigneeId: assignee,
                  sourceHash: data!.source.sourceHash,
                });
                setChecked([]);
              }, "Черновик пилота подготовлен. Проверьте его в разделе кампаний")
            }
          >
            Подготовить черновик
          </button>
        </section>
      )}
      {canManage && (
        <details className="card">
          <summary className="cursor-pointer font-semibold">
            Утвердить условия и скрипт
          </summary>
          <fieldset disabled={busy} className="mt-3 grid gap-3">
            <textarea
              aria-label="Текст скрипта"
              className="input"
              maxLength={4000}
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
            />
            <input
              aria-label="Владелец скрипта"
              className="input"
              placeholder="Владелец обновления"
              value={scriptOwner}
              onChange={(e) => setScriptOwner(e.target.value)}
            />
            <label>
              Действует до, МСК
              <input
                className="input"
                type="datetime-local"
                value={scriptUntil}
                onChange={(e) => setScriptUntil(e.target.value)}
              />
            </label>
            <button
              disabled={
                busy ||
                !scriptText.trim() ||
                !scriptOwner.trim() ||
                !scriptUntil
              }
              className="btn btn-primary"
              onClick={() =>
                void action(async () => {
                  await apiPost("/loyalty-workflow/agencies-v1-2/script", {
                    expectedVersion:
                      scriptDraft.version ?? data!.script.version,
                    text: scriptText,
                    owner: scriptOwner,
                    validUntil: contactDateFromInput(scriptUntil),
                  });
                  resetScriptDraft({
                    text: "",
                    owner: "",
                    until: "",
                    version: null,
                  });
                }, "Скрипт утверждён; предыдущая версия сохранена в аудите")
              }
            >
              Утвердить
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Удалить несохранённый черновик скрипта?"))
                  resetScriptDraft({
                    text: "",
                    owner: "",
                    until: "",
                    version: null,
                  });
              }}
            >
              Отменить черновик скрипта
            </button>
          </fieldset>
        </details>
      )}
      {dashboard && (
        <LoyaltyCampaignDashboard
          base="ours"
          entityType="agencies"
          canAssign={canAssign}
          canExport={!!data?.permissions.includes("EXPORT")}
          operators={operators}
          onClose={() => setDashboard(false)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
