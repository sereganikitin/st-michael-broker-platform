type ContactCard = {
  phone?: string | null;
  callContacts?: Array<{ name: string; phone: string; alternatePhone: string; archived: boolean }>;
};

export function agencyQueueContact(card: ContactCard) {
  const dialable = (phone?: string | null) => Boolean(phone && /^\+?[\d ()-]+$/.test(phone) && phone.replace(/\D/g, "").length >= 5);
  const contact = card.callContacts?.find(c => !c.archived && (dialable(c.phone) || dialable(c.alternatePhone)));
  if (dialable(card.phone)) return { phone: card.phone!, name: contact?.name || "Контактное лицо не указано" };
  if (contact) return { phone: dialable(contact.phone) ? contact.phone : contact.alternatePhone, name: contact.name };
  return { phone: "Нет телефона", name: "Контактное лицо не указано" };
}

export function restoredAgencyFilters(snapshot: Record<string, unknown>) {
  const id = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : "";
  return {
    agency: id(snapshot.agency),
    agencyType: ["АН", "Ключевой", "Агрегатор"].includes(String(snapshot.agencyType)) ? String(snapshot.agencyType) : "",
  };
}

export function sourcePriority(periods: Array<{ fields: Array<{ label: string; value: string }> }>) {
  const priorities = [...new Set(periods.flatMap(p => p.fields.filter(f => f.label === "Приоритет" && f.value.trim()).map(f => f.value.trim())))];
  return priorities.length ? priorities.join(" / ") : "не указан";
}
