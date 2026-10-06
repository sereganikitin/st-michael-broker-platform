import { CmsService } from "../cms/cms.service";
import { PrivacyService, DEFAULT_PRIVACY } from "../privacy/privacy.service";
import { OfferService, DEFAULT_OFFER } from "../offer/offer.service";
import {
  BROKER_CONTACT_EMAIL,
  CONTACT_EMAIL_TERMS_VERSION,
  normalizeLegacyContactBlock,
  replaceLegacyTermsContact,
} from "./broker-contact-email";
import { getArchivedLegalTerms } from "./legal-terms-archive";
import { publishBrokerContactEmail } from "./publish-broker-contact-email";

const oldEmail = "info@zorge9.com";
const now = new Date("2026-10-06T12:00:00.000Z");
const oldTerms = (label: string) => ({
  version: "2026-06-15",
  title: label,
  body: `${label} contact ${oldEmail}. Custom terms preserved.`,
  updatedAt: "2026-06-15T00:00:00.000Z",
  customField: { preserve: true },
});
const row = (key: string, value: any) => ({
  key,
  value,
  updatedAt: new Date("2026-10-05T12:00:00.000Z"),
});
const fixtureRows = () => [
  row("contact", {
    email: oldEmail,
    phone: "public-phone",
    nested: { email: oldEmail },
  }),
  row("offer_terms", oldTerms("Offer")),
  row("privacy_terms", oldTerms("Privacy")),
];
const copy = (value: any): any => {
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copy(item)]),
    );
  return value;
};

function harness(initial = fixtureRows()) {
  let rows = copy(initial);
  let revisions: any[] = [];
  const tx: any = {
    siteContent: {
      findMany: jest.fn(async () => copy(rows)),
      updateMany: jest.fn(async ({ where, data }) => {
        const current = rows.find(
          (item) =>
            item.key === where.key &&
            item.updatedAt.getTime() === where.updatedAt.getTime(),
        );
        if (!current) return { count: 0 };
        current.value = copy(data.value);
        current.updatedAt = new Date(now);
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }) => {
        if (rows.some((item) => item.key === data.key))
          throw new Error("unique-conflict");
        const created = row(data.key, copy(data.value));
        rows.push(created);
        return copy(created);
      }),
    },
    siteContentRevision: {
      findMany: jest.fn(async ({ where }) =>
        copy(
          revisions.filter(
            (item) =>
              item.key === where.key &&
              item.value.version === where.value.equals,
          ),
        ),
      ),
      create: jest.fn(async ({ data }) => {
        const created = {
          ...copy(data),
          id: `revision-${revisions.length + 1}`,
        };
        revisions.push(created);
        return copy(created);
      }),
    },
  };
  const prisma: any = {
    $transaction: jest.fn(async (action) => {
      const beforeRows = copy(rows),
        beforeRevisions = copy(revisions);
      try {
        return await action(tx);
      } catch (error) {
        rows = beforeRows;
        revisions = beforeRevisions;
        throw error;
      }
    }),
  };
  return {
    prisma,
    tx,
    rows: () => rows,
    revisions: () => revisions,
    seedRevisions: (values: any[]) => {
      revisions = copy(values);
    },
  };
}

describe("scoped broker contact and legal editions", () => {
  it.each([oldEmail, " INFO@ZORGE9.COM "])(
    "normalizes only legacy contact.email without mutating the input",
    (email) => {
      const value = {
        email,
        phone: "unchanged",
        nested: { email: oldEmail },
        body: oldEmail,
      };
      const result = normalizeLegacyContactBlock(value);
      expect(result).toEqual({ ...value, email: BROKER_CONTACT_EMAIL });
      expect(value.email).toBe(email);
      expect(result.nested).toBe(value.nested);
    },
  );
  it.each([
    null,
    [],
    "info@zorge9.com",
    { email: "different@example.test" },
    { body: oldEmail },
  ])("leaves unrelated values intact", (value) => {
    expect(normalizeLegacyContactBlock(value)).toBe(value);
  });
  it("normalizes saved and default CMS contact only, never arbitrary blocks/history", async () => {
    const contact = {
      email: oldEmail,
      phone: "saved",
      nested: { email: oldEmail },
    };
    const prisma: any = {
      siteContent: {
        findMany: jest.fn().mockResolvedValue([
          { key: "contact", value: contact },
          { key: "custom", value: { email: oldEmail } },
        ]),
        findUnique: jest.fn(async ({ where }) =>
          where.key === "contact"
            ? { value: contact }
            : where.key === "custom"
              ? { value: { email: oldEmail } }
              : null,
        ),
      },
    };
    const cms = new CmsService(prisma);
    expect((await cms.getAllContent()).contact.email).toBe(
      BROKER_CONTACT_EMAIL,
    );
    expect((await cms.getAllContent()).custom.email).toBe(oldEmail);
    expect(((await cms.getContent("contact")) as any).email).toBe(
      BROKER_CONTACT_EMAIL,
    );
    expect(((await cms.getContent("custom")) as any).email).toBe(oldEmail);
    expect(contact.email).toBe(oldEmail);
    prisma.siteContent.findUnique.mockResolvedValue(null);
    expect(((await cms.getContent("contact")) as any).email).toBe(
      BROKER_CONTACT_EMAIL,
    );
  });
  it("defaults use the common new version but existing saved editions remain untouched on reads", async () => {
    const prisma: any = {
      siteContent: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const offer = new OfferService(prisma),
      privacy = new PrivacyService(prisma);
    expect((await offer.getCurrent()).version).toBe(
      CONTACT_EMAIL_TERMS_VERSION,
    );
    expect((await privacy.getCurrent()).version).toBe(
      CONTACT_EMAIL_TERMS_VERSION,
    );
    for (const terms of [DEFAULT_OFFER, DEFAULT_PRIVACY]) {
      expect(terms.body).toContain(BROKER_CONTACT_EMAIL);
      expect(terms.body).not.toContain(oldEmail);
    }
    const saved = oldTerms("Unpublished");
    prisma.siteContent.findUnique.mockResolvedValue({ value: saved });
    expect(await offer.getCurrent()).toBe(saved);
    expect(await privacy.getCurrent()).toBe(saved);
    expect(saved.body).toContain(oldEmail);
  });
  it("replaces only the actual legacy address in a newly published legal text", () => {
    expect(
      replaceLegacyTermsContact(`Contact INFO@ZORGE9.COM. (${oldEmail})`),
    ).toBe(`Contact ${BROKER_CONTACT_EMAIL}. (${BROKER_CONTACT_EMAIL})`);
    const unrelated = `xinfo@zorge9.com user+info@zorge9.com info@zorge9.com.other`;
    expect(replaceLegacyTermsContact(unrelated)).toBe(unrelated);
  });
});

describe("explicit transactional contact-email publication", () => {
  it("plans with reads only; apply without a reviewed hash never accesses the DB", async () => {
    const h = harness();
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    expect(plan).toMatchObject({
      applied: false,
      changedKeys: ["contact", "offer_terms", "privacy_terms"],
    });
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.tx.siteContent.updateMany).not.toHaveBeenCalled();
    expect(h.tx.siteContentRevision.create).not.toHaveBeenCalled();
    h.prisma.$transaction.mockClear();
    await expect(
      publishBrokerContactEmail(h.prisma, { apply: true }),
    ).rejects.toThrow("PUBLICATION_PLAN_REQUIRED");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("archives exact old/new editions, preserves all other fields and is idempotent", async () => {
    const h = harness();
    const before = copy(h.rows());
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    expect(
      await publishBrokerContactEmail(h.prisma, {
        apply: true,
        expectedPlanHash: plan.planHash,
        now,
      }),
    ).toMatchObject({ applied: true });
    expect(h.prisma.$transaction.mock.calls[1][1]).toEqual({
      isolationLevel: "Serializable",
      timeout: 15000,
    });
    for (const [index, key] of ["offer_terms", "privacy_terms"].entries()) {
      const current = h.rows().find((item: any) => item.key === key).value;
      expect(current).toEqual({
        ...before[index + 1].value,
        body: before[index + 1].value.body.replace(
          oldEmail,
          BROKER_CONTACT_EMAIL,
        ),
        version: CONTACT_EMAIL_TERMS_VERSION,
        updatedAt: now.toISOString(),
      });
      expect(
        h
          .revisions()
          .find(
            (item) => item.key === key && item.value.version === "2026-06-15",
          ).value,
      ).toEqual(before[index + 1].value);
      expect(
        h
          .revisions()
          .find(
            (item) =>
              item.key === key &&
              item.value.version === CONTACT_EMAIL_TERMS_VERSION,
          ).value,
      ).toEqual(current);
    }
    expect(h.rows()[0].value.nested.email).toBe(oldEmail);
    const revisionCount = h.revisions().length;
    const second = await publishBrokerContactEmail(h.prisma, { now });
    expect(second.changedKeys).toEqual([]);
    await publishBrokerContactEmail(h.prisma, {
      apply: true,
      expectedPlanHash: second.planHash,
      now,
    });
    expect(h.revisions()).toHaveLength(revisionCount);
    expect(h.prisma).not.toHaveProperty("offerAcceptance");
    expect(h.prisma).not.toHaveProperty("broker");
  });
  it("materializes missing terms and archives the previous fallback, without inventing a contact row", async () => {
    const h = harness([]);
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    await publishBrokerContactEmail(h.prisma, {
      apply: true,
      expectedPlanHash: plan.planHash,
      now,
    });
    expect(h.rows().map((item: any) => item.key)).toEqual([
      "offer_terms",
      "privacy_terms",
    ]);
    for (const key of ["offer_terms", "privacy_terms"]) {
      const old = h
        .revisions()
        .find(
          (item) => item.key === key && item.value.version === "2026-06-15",
        ).value;
      expect(old.body).toContain(oldEmail);
      expect(old.body).not.toContain(BROKER_CONTACT_EMAIL);
    }
    expect(h.revisions()).toHaveLength(4);
  });
  it("fails closed on an externally set new version without its edition archive", async () => {
    const h = harness([
      row("offer_terms", DEFAULT_OFFER),
      row("privacy_terms", DEFAULT_PRIVACY),
    ]);
    const before = copy(h.rows());
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    expect(plan.changedKeys).toEqual([]);
    await expect(
      publishBrokerContactEmail(h.prisma, {
        apply: true,
        expectedPlanHash: plan.planHash,
        now,
      }),
    ).rejects.toThrow("PUBLICATION_ARCHIVE_READBACK_FAILED");
    expect(h.rows()).toEqual(before);
    expect(h.revisions()).toEqual([]);
  });
  it("aborts when the reviewed plan becomes stale before apply", async () => {
    const h = harness();
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    h.rows()[0].value.phone = "changed by operator";
    await expect(
      publishBrokerContactEmail(h.prisma, {
        apply: true,
        expectedPlanHash: plan.planHash,
        now,
      }),
    ).rejects.toThrow("PUBLICATION_PLAN_CHANGED");
    expect(h.revisions()).toEqual([]);
    expect(h.tx.siteContent.updateMany).not.toHaveBeenCalled();
  });
  it("rolls back archives and every scoped update on CAS conflict", async () => {
    const h = harness();
    const before = copy(h.rows());
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    h.tx.siteContent.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      publishBrokerContactEmail(h.prisma, {
        apply: true,
        expectedPlanHash: plan.planHash,
        now,
      }),
    ).rejects.toThrow("PUBLICATION_CAS_CONFLICT");
    expect(h.rows()).toEqual(before);
    expect(h.revisions()).toEqual([]);
  });
  it("rolls back the entire publication if final read-back differs", async () => {
    const h = harness();
    const before = copy(h.rows());
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    h.tx.siteContent.findMany
      .mockResolvedValueOnce(copy(before))
      .mockResolvedValueOnce([]);
    await expect(
      publishBrokerContactEmail(h.prisma, {
        apply: true,
        expectedPlanHash: plan.planHash,
        now,
      }),
    ).rejects.toThrow("PUBLICATION_READBACK_FAILED");
    expect(h.rows()).toEqual(before);
    expect(h.revisions()).toEqual([]);
  });
  it("rolls back all changes when the previous legal archive cannot be read back", async () => {
    const h = harness();
    const before = copy(h.rows());
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    h.tx.siteContentRevision.findMany.mockResolvedValue([]);
    await expect(
      publishBrokerContactEmail(h.prisma, {
        apply: true,
        expectedPlanHash: plan.planHash,
        now,
      }),
    ).rejects.toThrow("PUBLICATION_ARCHIVE_READBACK_FAILED");
    expect(h.rows()).toEqual(before);
    expect(h.revisions()).toEqual([]);
  });
  it.each([
    { ...oldTerms("Broken"), body: null },
    { ...oldTerms("Broken"), version: CONTACT_EMAIL_TERMS_VERSION },
    { ...oldTerms("Broken"), body: "No approved contact in this edition" },
  ])(
    "fails closed on invalid or conflicting current legal terms",
    async (value) => {
      const h = harness([row("offer_terms", value)]);
      await expect(
        publishBrokerContactEmail(h.prisma, { now }),
      ).rejects.toThrow(/PUBLICATION_/);
      expect(h.revisions()).toEqual([]);
      expect(h.tx.siteContent.updateMany).not.toHaveBeenCalled();
    },
  );
  it("rolls back on a conflicting archive under the previous version", async () => {
    const h = harness();
    const before = copy(h.rows());
    h.seedRevisions([
      {
        key: "offer_terms",
        value: { ...oldTerms("Offer"), body: "different historical text" },
      },
    ]);
    const plan = await publishBrokerContactEmail(h.prisma, { now });
    await expect(
      publishBrokerContactEmail(h.prisma, {
        apply: true,
        expectedPlanHash: plan.planHash,
        now,
      }),
    ).rejects.toThrow("PUBLICATION_ARCHIVE_CONFLICT");
    expect(h.rows()).toEqual(before);
    expect(h.revisions()).toHaveLength(1);
  });
});

describe("acceptance-bound offer archives", () => {
  function serviceHarness(archives: any[]) {
    const prisma: any = {
      broker: {
        findUnique: jest.fn().mockResolvedValue({
          fullName: "Broker",
          phone: "test-phone",
          brokerAgencies: [],
        }),
      },
      siteContent: {
        findUnique: jest.fn().mockResolvedValue({ value: DEFAULT_OFFER }),
      },
      offerAcceptance: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
          id: "old-acceptance",
          offerVersion: "2026-06-15",
          acceptedAt: "2026-09-01",
          ip: null,
        }),
      },
      siteContentRevision: { findMany: jest.fn().mockResolvedValue(archives) },
    };
    return { prisma, service: new OfferService(prisma) };
  }
  it("renders the precise old accepted text, not the new public version", async () => {
    const archived = oldTerms("Old accepted edition");
    const h = serviceHarness([{ value: archived }]);
    const html = await h.service.getSignedDocumentHtml("broker-test");
    expect(html).toContain(archived.body);
    expect(html).toContain("2026-06-15");
    expect(html).toContain("old-acceptance");
    expect(html).not.toContain(CONTACT_EMAIL_TERMS_VERSION);
    expect(html).not.toContain(BROKER_CONTACT_EMAIL);
    expect(
      h.prisma.siteContentRevision.findMany.mock.calls[0][0].where,
    ).toEqual({
      key: "offer_terms",
      value: { path: ["version"], equals: "2026-06-15" },
    });
  });
  it.each(
    [
      [],
      [{ value: { ...oldTerms("Wrong"), version: "another-version" } }],
      [{ value: oldTerms("One") }, { value: oldTerms("Two") }],
      [{ value: { version: "2026-06-15", body: "invalid" } }],
    ].map((archives) => ({ archives })),
  )(
    "refuses missing, invalid or ambiguous historical editions",
    async ({ archives }) => {
      const h = serviceHarness(archives);
      await expect(
        h.service.getSignedDocumentHtml("broker-test"),
      ).rejects.toThrow("Принятая редакция оферты недоступна в архиве");
    },
  );
  it("does not use an archive unless this broker has an acceptance", async () => {
    const h = serviceHarness([{ value: oldTerms("Old") }]);
    h.prisma.offerAcceptance.findFirst.mockReset().mockResolvedValue(null);
    await expect(
      h.service.getSignedDocumentHtml("broker-test"),
    ).rejects.toThrow("Оферта ещё не принята");
    expect(h.prisma.siteContentRevision.findMany).not.toHaveBeenCalled();
  });
  it.each(["missing", "changed", "matching"])(
    "checks the exact archive for a currently accepted edition: %s",
    async (mode) => {
      const h = serviceHarness(
        mode === "missing" ? [] : [{ value: DEFAULT_OFFER }],
      );
      h.prisma.offerAcceptance.findFirst.mockReset().mockResolvedValue({
        id: "current-acceptance",
        offerVersion: CONTACT_EMAIL_TERMS_VERSION,
        acceptedAt: "2026-10-06",
        ip: null,
      });
      if (mode === "changed")
        h.prisma.siteContent.findUnique.mockResolvedValue({
          value: { ...DEFAULT_OFFER, body: "Changed under same version" },
        });
      if (mode === "matching") {
        const html = await h.service.getSignedDocumentHtml("broker-test");
        expect(html).toContain(BROKER_CONTACT_EMAIL);
        expect(html).toContain("current-acceptance");
      } else
        await expect(
          h.service.getSignedDocumentHtml("broker-test"),
        ).rejects.toThrow("Принятая редакция оферты недоступна в архиве");
      expect(h.prisma.offerAcceptance.findFirst).toHaveBeenCalledTimes(1);
    },
  );
  it("allows identical snapshots but rejects distinct texts under one version", async () => {
    const h = serviceHarness([
      { value: oldTerms("Same") },
      { value: oldTerms("Same") },
    ]);
    expect(
      await getArchivedLegalTerms(h.prisma, "offer_terms", "2026-06-15"),
    ).toEqual(oldTerms("Same"));
  });
});
