import { matchPartnerName, normalizePartnerName } from "./match-word-to-anna";

const catalog = [
  {
    id: "ag-trend",
    entityType: "AGENCY" as const,
    names: ["TrendAgent", "Trend Agent"],
  },
  {
    id: "ag-high",
    entityType: "AGENCY" as const,
    names: ["HighPoint", "ИП Цюрупа"],
  },
  {
    id: "ag-neo",
    entityType: "AGENCY" as const,
    names: ["НЕОСИТИ"],
  },
  {
    id: "ag-prime-samolet",
    entityType: "AGENCY" as const,
    names: ["Прайм Самолет Плюс", "Прайм Самолет+"],
  },
  {
    id: "ag-prime-caps",
    entityType: "AGENCY" as const,
    names: ["PRIME"],
  },
  {
    id: "ag-prime-title",
    entityType: "AGENCY" as const,
    names: ["Prime"],
  },
  {
    id: "ag-flat",
    entityType: "AGENCY" as const,
    names: ["Flat"],
  },
];

describe("match Word program names to Anna agencies", () => {
  it("normalizes legal-form noise", () => {
    expect(normalizePartnerName('ООО «АФК»')).toBe("афк");
    expect(normalizePartnerName("Trend Agent")).toBe("trend agent");
  });

  it("auto-matches a unique alias like Trend Agent → TrendAgent", () => {
    const result = matchPartnerName("trend-agent", "Trend Agent", catalog);
    expect(result.status).toBe("AUTO");
    expect(result.candidates).toEqual([
      { id: "ag-trend", entityType: "AGENCY", name: "TrendAgent" },
    ]);
  });

  it("auto-matches HighPoint from the Word parentheses name", () => {
    const result = matchPartnerName(
      "highpoint",
      "ИП Цюрупа Ю.А. (HighPoint)",
      catalog,
    );
    expect(result.status).toBe("AUTO");
    expect(result.candidates[0]?.id).toBe("ag-high");
  });

  it("leaves PRIME ambiguous when several Anna cards collapse to the same name", () => {
    const result = matchPartnerName("prime", "PRIME", catalog);
    expect(result.status).toBe("AMBIGUOUS");
    expect(result.candidates.map((row) => row.id).sort()).toEqual([
      "ag-prime-caps",
      "ag-prime-title",
    ]);
  });

  it("auto-matches the longer unique name Прайм Самолет Плюс", () => {
    const result = matchPartnerName(
      "prime-samolet",
      "Прайм Самолет Плюс",
      catalog,
    );
    expect(result.status).toBe("AUTO");
    expect(result.candidates[0]?.id).toBe("ag-prime-samolet");
  });

  it("returns unmatched with empty candidates when nothing is close", () => {
    const result = matchPartnerName("unknown", "Совсем другая сеть", catalog);
    expect(result.status).toBe("UNMATCHED");
    expect(result.candidates).toEqual([]);
  });
});
