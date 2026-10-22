import {
  AmoCrmAdapter,
  getAmoTokens,
  setAmoTokens,
} from "../../../../packages/integrations/src/amo-crm.adapter";
import {
  AMO_BROKER_STAGE,
  AMO_KC_STATUS,
  AMO_PIPELINES,
  evaluateUniqueness,
  isBrokerOnboardingLead,
  isClassifiedUniquenessLeadStage,
  isKnownUniquenessLeadStage,
} from "../../../../packages/integrations/src/amo-crm.fields";
import { uniquenessFailureDetail } from "./client-fixation.service";

// 2026-10-22: case of 20.10 — the client's amoCRM contact also had a
// «Воронка брокеров» card at «Новый брокер», and the broker got a 503.
describe("uniqueness and the broker pipeline", () => {
  const lead = (id: number, pipeline_id: number, status_id: number) => ({
    id,
    pipeline_id,
    status_id,
    hasBrokerAttached: false,
  });

  it("treats only «Новый брокер» and «Брокер-тур» as partner onboarding cards", () => {
    expect(isBrokerOnboardingLead(AMO_PIPELINES.BROKERS, AMO_BROKER_STAGE.NEW)).toBe(true);
    expect(isBrokerOnboardingLead(AMO_PIPELINES.BROKERS, AMO_BROKER_STAGE.TOUR)).toBe(true);
    for (const stage of [AMO_BROKER_STAGE.FIXATION, AMO_BROKER_STAGE.MEETING, AMO_BROKER_STAGE.DEAL]) {
      expect(isBrokerOnboardingLead(AMO_PIPELINES.BROKERS, stage)).toBe(false);
      expect(isKnownUniquenessLeadStage(AMO_PIPELINES.BROKERS, stage)).toBe(false);
    }
    expect(isBrokerOnboardingLead(AMO_PIPELINES.KC, AMO_BROKER_STAGE.NEW)).toBe(false);
    expect(isKnownUniquenessLeadStage(AMO_PIPELINES.BROKERS, AMO_BROKER_STAGE.NEW)).toBe(true);
    expect(isClassifiedUniquenessLeadStage(AMO_PIPELINES.BROKERS, AMO_BROKER_STAGE.TOUR)).toBe(true);
  });

  it("ignores an onboarding card but keeps every client pipeline rule", () => {
    expect(evaluateUniqueness([lead(1, AMO_PIPELINES.BROKERS, AMO_BROKER_STAGE.NEW)]).rule).toBe("RULE_3");
    const withKc = evaluateUniqueness([
      lead(1, AMO_PIPELINES.BROKERS, AMO_BROKER_STAGE.TOUR),
      lead(2, AMO_PIPELINES.KC, AMO_KC_STATUS.NEW_REQUEST),
    ]);
    expect(withKc.rule).toBe("RULE_1");
    expect(withKc.triggerLeadId).toBe(2);
  });

  describe("AmoCrmAdapter.checkUniqueness", () => {
    let originalTokens: ReturnType<typeof getAmoTokens>;
    beforeEach(() => {
      originalTokens = getAmoTokens();
      setAmoTokens("test-token", "");
    });
    afterEach(() => {
      setAmoTokens(originalTokens.access, originalTokens.refresh);
      jest.restoreAllMocks();
    });

    const mockLeads = (adapter: AmoCrmAdapter, statusId: number) => {
      jest.spyOn(adapter, "findContactByPhone").mockResolvedValue({ id: 200, name: "Client" });
      jest
        .spyOn(adapter as any, "request")
        .mockResolvedValueOnce({ _embedded: { leads: [{ id: 201 }] } })
        .mockResolvedValueOnce({
          _embedded: {
            leads: [{ id: 201, pipeline_id: AMO_PIPELINES.BROKERS, status_id: statusId, _embedded: { contacts: [{ id: 200 }] } }],
          },
        });
      jest.spyOn(adapter, "getContactsByIds").mockResolvedValue(new Map([[200, { id: 200 }]]) as any);
    };

    it("returns a verdict instead of failing for a «Новый брокер» card", async () => {
      const adapter = new AmoCrmAdapter();
      mockLeads(adapter, AMO_BROKER_STAGE.NEW);
      await expect(adapter.checkUniqueness("+79990000020")).resolves.toEqual(
        expect.objectContaining({ rule: "RULE_3", verdict: "UNIQUE", contactId: 200 }),
      );
    });

    it("still fails closed for later broker-pipeline stages and reports only stage ids", async () => {
      const adapter = new AmoCrmAdapter();
      mockLeads(adapter, AMO_BROKER_STAGE.FIXATION);
      const error = await adapter.checkUniqueness("+79990000021").catch((e) => e);
      expect(error.message).toBe("AMO_UNIQUENESS_LEAD_STAGE_UNRECOGNIZED");
      expect(uniquenessFailureDetail(error)).toBe(
        `uniqueness=AMO_UNIQUENESS_LEAD_STAGE_UNRECOGNIZED pipeline=${AMO_PIPELINES.BROKERS} status=${AMO_BROKER_STAGE.FIXATION}`,
      );
    });
  });

  it("log detail never echoes arbitrary error text", () => {
    expect(uniquenessFailureDetail(new Error("amoCRM 500 /contacts?query=79990000022"))).toBe(
      "uniqueness=n/a pipeline=n/a status=n/a",
    );
    expect(uniquenessFailureDetail(Object.assign(new Error("AMBIGUOUS_EXACT_CONTACT"), { amoPipelineId: "79990000022" }))).toBe(
      "uniqueness=AMBIGUOUS_EXACT_CONTACT pipeline=n/a status=n/a",
    );
    expect(uniquenessFailureDetail(undefined)).toBe("uniqueness=n/a pipeline=n/a status=n/a");
  });
});
