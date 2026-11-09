import { resolveAgencyCompanyProfile } from "./agency-company-profile";

const INN = "9702028892";
const checkedAt = new Date("2026-11-08T21:30:00.000Z");
const updatedAt = 1794042040;
const field = (id: number, ...values: unknown[]) => ({
  field_id: id,
  values: values.map((value) => ({ value })),
});
const company = (
  id: number,
  fields: any[] = [],
  inn = INN,
  updated: number = updatedAt,
) => ({
  id,
  name: "ООО «Онлайн Недвижимость»",
  updated_at: updated,
  custom_fields_values: [field(663911, inn), ...fields],
});
const resolve = (companies: any[]) =>
  resolveAgencyCompanyProfile(INN, companies, checkedAt);

describe("agency company profile evidence mapper", () => {
  it("links by exact normalized INN and ignores identical company names", () => {
    const result = resolveAgencyCompanyProfile(
      "9702 028892",
      [
        company(1, [field(557907, "example.ru")], "9702-028892"),
        company(2, [field(557907, "foreign.ru")], "9702028893"),
        { id: 3, name: "ООО «Онлайн Недвижимость»", custom_fields_values: [] },
      ],
      checkedAt,
    );
    expect(result.companyIds).toEqual(["1"]);
    expect(result.status).toBe("LINKED");
    expect(result.profile.website).toBe("https://example.ru/");
  });

  it.each(["", "9702", "00000000000"])(
    "does not match invalid INN %p",
    (inn) => {
      expect(
        resolveAgencyCompanyProfile(inn, [company(1)], checkedAt),
      ).toMatchObject({
        status: "NOT_FOUND",
        companyIds: [],
        contracts: [],
        fieldSources: {},
        sourceUpdatedAt: null,
      });
    },
  );

  it("supports 12-digit INN and ignores malformed company records", () => {
    expect(
      resolveAgencyCompanyProfile(
        "123456789012",
        [null, {}, company(1, [], "123456789012")],
        checkedAt,
      ),
    ).toMatchObject({ status: "LINKED", companyIds: ["1"] });
  });

  it("combines identical field evidence and preserves values beside newer empty duplicates", () => {
    const result = resolve([
      company(
        2,
        [field(557907, "https://example.ru/"), field(663927, "действующая")],
        INN,
        1794042050,
      ),
      company(1, [field(557907, "example.ru"), field(663927, " действующая ")]),
      company(3, [], INN, 1794073959),
    ]);
    expect(result.profile).toMatchObject({
      website: "https://example.ru/",
      legalStatus: "действующая",
    });
    expect(result.fieldSources.website).toEqual({
      source: "AMOCRM_COMPANY",
      companyIds: ["1", "2"],
      fieldId: 557907,
      sourceUpdatedAt: new Date(1794042050 * 1000).toISOString(),
      checkedAt: checkedAt.toISOString(),
    });
    expect(result.sourceUpdatedAt).toBe(
      new Date(1794073959 * 1000).toISOString(),
    );
  });

  it("isolates conflicting websites while preserving independent fields", () => {
    const result = resolve([
      company(2, [field(557907, "other.ru"), field(558649, "Договор")]),
      company(1, [field(557907, "example.ru"), field(558649, "Договор")]),
    ]);
    expect(result.status).toBe("CONFLICT");
    expect(result.profile.website).toBeNull();
    expect(result.fieldSources.website).toBeUndefined();
    expect(result.conflicts.website.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "https://example.ru/",
          companyIds: ["1"],
          fieldId: 557907,
        }),
        expect.objectContaining({
          value: "https://other.ru/",
          companyIds: ["2"],
          fieldId: 557907,
        }),
      ]),
    );
    expect(result.profile.relationshipForm).toBe("Договор");
    expect(result.fieldSources.relationshipForm.companyIds).toEqual(["1", "2"]);
  });

  it.each([
    "javascript:alert(1)",
    "javascript://example.ru",
    "/relative",
    "../relative",
    "//example.ru",
    "relative/path",
    "123",
    "ftp://example.ru",
    "https://user:password@example.ru",
    "not a website",
  ])("rejects invalid or unsafe website %p", (website) => {
    expect(
      resolve([company(1, [field(557907, website)])]).profile.website,
    ).toBeNull();
  });

  it.each([
    ["https://EXAMPLE.ru", "https://example.ru/"],
    ["http://example.ru/path", "http://example.ru/path"],
    ["example.ru:8443/path", "https://example.ru:8443/path"],
  ])("normalizes website %p", (raw, expected) => {
    expect(resolve([company(1, [field(557907, raw)])]).profile.website).toBe(
      expected,
    );
  });

  it("maps confirmed metadata and treats multiselect ordering as identical", () => {
    const result = resolve([
      company(1, [
        field(558641, "брокер"),
        field(558645, "агентство недвижимости", "банк"),
        field(663925, "09.06.2025"),
      ]),
      company(2, [
        field(558645, "банк", "агентство недвижимости", "банк"),
        field(663925, "2025-06-09"),
      ]),
    ]);
    expect(result.profile).toMatchObject({
      companyType: "брокер",
      industry: ["агентство недвижимости", "банк"],
      legalDataAsOf: "2025-06-09",
    });
    expect(result.fieldSources.industry.companyIds).toEqual(["1", "2"]);
    expect(result.profile).not.toHaveProperty("partnershipLevel");
    expect(result.profile).not.toHaveProperty("agencySize");
    expect(result.profile).not.toHaveProperty("projectsOnSite");
  });

  it("reports different valid metadata values without selecting an arbitrary source", () => {
    const result = resolve([
      company(1, [field(663925, "09.06.2025")]),
      company(2, [field(663925, "15.01.2026")]),
    ]);
    expect(result.profile.legalDataAsOf).toBeNull();
    expect(
      result.conflicts.legalDataAsOf.candidates.map((c) => c.value),
    ).toEqual(["2025-06-09", "2026-01-15"]);
  });

  it("selects the latest contract date and number from the same company, preserving history", () => {
    const result = resolve([
      company(43419077, [
        field(842477, 1763758800),
        field(842479, "УБ76-12/2025"),
      ]),
      company(
        47176043,
        [field(842477, 1711141200), field(842479, "УБ26-05/2024")],
        INN,
        1794073957,
      ),
      company(47206399, [], INN, 1794073959),
    ]);
    expect(result.profile).toMatchObject({
      lastContractDate: "2025-11-22",
      lastContractNumber: "УБ76-12/2025",
    });
    expect(result.fieldSources.lastContractDate).toMatchObject({
      companyIds: ["43419077"],
      fieldId: 842477,
    });
    expect(result.fieldSources.lastContractNumber).toMatchObject({
      companyIds: ["43419077"],
      fieldId: 842479,
    });
    expect(result.contracts).toHaveLength(2);
    expect(result.contracts.map((c) => c.date)).toEqual([
      "2025-11-22",
      "2024-03-23",
    ]);
  });

  it("does not borrow an older contract number when the latest dated company has none", () => {
    const result = resolve([
      company(1, [field(842477, "2026-09-01")]),
      company(2, [field(842477, "2025-09-01"), field(842479, "OLD")]),
    ]);
    expect(result.profile.lastContractDate).toBe("2026-09-01");
    expect(result.profile.lastContractNumber).toBeNull();
    expect(result.fieldSources.lastContractNumber).toBeUndefined();
  });

  it("combines identical latest contracts and exposes different numbers on the latest date", () => {
    const identical = [
      company(1, [field(842477, "2026-09-01"), field(842479, "A")]),
      company(2, [field(842477, "01.09.2026"), field(842479, "A")]),
    ];
    expect(
      resolve(identical).fieldSources.lastContractNumber.companyIds,
    ).toEqual(["1", "2"]);
    const result = resolve([
      ...identical,
      company(3, [field(842477, "2026-09-01"), field(842479, "B")]),
    ]);
    expect(result.status).toBe("CONFLICT");
    expect(result.profile.lastContractDate).toBe("2026-09-01");
    expect(result.profile.lastContractNumber).toBeNull();
    expect(
      result.conflicts.lastContractNumber.candidates.map((c) => c.value),
    ).toEqual(["A", "B"]);
  });

  it("excludes future contracts using Moscow today and retains their history flag", () => {
    const result = resolve([
      company(1, [
        field(842477, "2026-11-08T21:00:00Z"),
        field(842479, "TODAY"),
      ]),
      company(2, [field(842477, "2026-11-10"), field(842479, "FUTURE")]),
    ]);
    expect(result.profile).toMatchObject({
      lastContractDate: "2026-11-09",
      lastContractNumber: "TODAY",
    });
    expect(result.contracts.find((c) => c.companyId === "2")).toMatchObject({
      date: "2026-11-10",
      isFuture: true,
    });
  });

  it.each([
    "2026-02-30",
    "31.02.2026",
    "2025-02-29",
    "2026-02-30T00:00:00Z",
    "2026-09-01T25:00:00Z",
    "not-a-date",
  ])(
    "rejects invalid contract date %p without silently rolling into another day",
    (date) => {
      const result = resolve([
        company(1, [field(842477, date), field(842479, "INVALID")]),
      ]);
      expect(result.profile.lastContractDate).toBeNull();
      expect(result.profile.lastContractNumber).toBeNull();
      expect(result.contracts[0]).toMatchObject({
        date: null,
        invalidDate: true,
        number: "INVALID",
      });
    },
  );

  it("accepts leap days, date objects and Unix milliseconds", () => {
    const result = resolve([
      company(1, [field(842477, "29.02.2024"), field(842479, "LEAP")]),
      company(2, [
        field(842477, new Date("2025-11-21T21:00:00Z")),
        field(842479, "NEW"),
      ]),
      company(3, [field(842477, 1763758800000), field(842479, "NEW")]),
    ]);
    expect(result.profile).toMatchObject({
      lastContractDate: "2025-11-22",
      lastContractNumber: "NEW",
    });
    expect(result.fieldSources.lastContractNumber.companyIds).toEqual([
      "2",
      "3",
    ]);
  });

  it("preserves malformed multivalue contract ambiguity", () => {
    const result = resolve([
      company(1, [
        field(842477, "2025-01-01", "2026-01-01"),
        field(842479, "A", "B"),
      ]),
    ]);
    expect(result.profile.lastContractDate).toBeNull();
    expect(result.contracts[0]).toMatchObject({
      date: null,
      number: null,
      ambiguousDate: true,
      dateCandidates: ["2025-01-01", "2026-01-01"],
      numberCandidates: ["A", "B"],
    });
  });

  it("is deterministic, deduplicates repeated history and leaves input intact", () => {
    const a = company(1, [
      field(842477, "2025-11-22"),
      field(842479, "A"),
      field(557907, "example.ru"),
    ]);
    const b = company(2, [
      field(842477, "2026-01-01"),
      field(842479, "B"),
      field(557907, "other.ru"),
    ]);
    const input = [a, b, a];
    const before = JSON.stringify(input);
    const result = resolve(input);
    expect(result).toEqual(resolve([b, a]));
    expect(result.contracts).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps conflicts deterministic for inconsistent copies of the same company", () => {
    const a = company(1, [field(842477, "2026-01-01"), field(842479, "A")]);
    const b = company(1, [field(842477, "2026-01-01"), field(842479, "B")]);
    expect(resolve([a, b])).toEqual(resolve([b, a]));
    expect(resolve([a, b]).status).toBe("CONFLICT");
  });

  it("rejects an invalid check timestamp", () => {
    expect(() => resolveAgencyCompanyProfile(INN, [], new Date(NaN))).toThrow(
      "Invalid checkedAt",
    );
  });
});
