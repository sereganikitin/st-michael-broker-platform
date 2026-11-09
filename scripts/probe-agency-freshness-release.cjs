"use strict";
const crypto = require("node:crypto");
const { PrismaClient } = require("@st-michael/database");
const EXPECTED = "19250ccb45bf8ba78639ac6c549df077d54c629c";
const TARGET = "372fa09f-373d-4c13-9ee2-484b75f4f3be";
const fail = code => { const error = new Error(code); error.safeCode = code; throw error; };
async function main() {
  if (process.env.GIT_SHA !== EXPECTED) fail("RELEASE_MISMATCH");
  const prisma = new PrismaClient({ log: [] });
  try {
    const admin = await prisma.broker.findFirst({ where: { role: "ADMIN", status: "ACTIVE", mergedIntoId: null, passwordHash: { not: null } }, select: { id: true, authVersion: true }, orderBy: { createdAt: "asc" } });
    if (!admin || !process.env.JWT_SECRET) fail("AUTH_UNAVAILABLE");
    const enc = data => Buffer.from(JSON.stringify(data)).toString("base64url");
    const issued = Math.floor(Date.now()/1000);
    const data = `${enc({alg:"HS256",typ:"JWT"})}.${enc({sub:admin.id,role:"ADMIN",type:"access",authVersion:admin.authVersion,iat:issued,exp:issued+600})}`;
    const token = `${data}.${crypto.createHmac("sha256",process.env.JWT_SECRET).update(data).digest("base64url")}`;
    const get = async path => {
      const response = await fetch(`http://127.0.0.1:4000/api${path}`, { headers: { authorization:`Bearer ${token}` }, signal:AbortSignal.timeout(120000) });
      if (!response.ok) fail(`HTTP_${response.status}`);
      return response.json();
    };
    const health = await get("/health"), ready = await get("/health/ready");
    if (health.deployedSha !== EXPECTED || ready.status !== "ok" || ready.checks?.postgresql !== "ok" || ready.checks?.redis !== "ok") fail("HEALTH_NOT_READY");
    const today = new Date(Date.now()+10800000).toISOString().slice(0,10);
    const parameters = {from:"2026-01-01",to:today,cabinetSource:"new"};
    const summaries = [];
    for (const mode of ["strict","all"]) {
      const query = new URLSearchParams({...parameters,mode});
      const result = await get(`/loyalty-base/ours/funnel?${query}`);
      if (result.mode !== mode) fail("MODE_MISMATCH");
      const steps = result.funnel?.steps;
      if (!Array.isArray(steps) || steps.length !== 5) fail("INVALID_FUNNEL");
      const counts = Object.fromEntries(steps.map(step=>[step.key,step.count]));
      for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0 || value > counts.brokerTour) fail("INVALID_COHORT_COUNT");
      const drills = {};
      for (const step of mode === "strict" ? ["fixation","meeting","deal"] : ["deal"]) {
        const drill = await get(`/loyalty-base/ours/funnel/drill?${query}&step=${step}&page=1&pageSize=100`);
        if (drill.total !== counts[step] || !Array.isArray(drill.items) || drill.items.length !== Math.min(100,drill.total)) fail("DRILL_COUNT_MISMATCH");
        if (drill.items.some(item=>!item.brokerId || !item.eventId || !item.eventAt)) fail("DRILL_EVIDENCE_MISSING");
        drills[step] = { total:drill.total, returned:drill.items.length };
      }
      summaries.push({mode,counts,drills});
    }
    const fromQuarter = "2026-10-01";
    const quarter = await get(`/loyalty-base/ours/funnel?${new URLSearchParams({from:fromQuarter,to:today,cabinetSource:"new",mode:"strict"})}`);
    const expectedQuarter = await prisma.broker.count({where:{role:"BROKER",mergedIntoId:null,brokerTourVisited:true,brokerTourDate:{gte:new Date(`${fromQuarter}T00:00:00+03:00`),lte:new Date(`${today}T23:59:59.999+03:00`)}}});
    const quarterCount = quarter.funnel.steps.find(step=>step.key==="brokerTour")?.count;
    if (quarterCount !== expectedQuarter) fail("QUARTER_COHORT_MISMATCH");
    const maxTour = await prisma.broker.aggregate({where:{role:"BROKER",mergedIntoId:null,brokerTourVisited:true},_max:{brokerTourDate:true}});
    const detail = await get(`/loyalty-base/ours/agencies/${TARGET}`);
    if (detail.item?.id !== TARGET) fail("DETAIL_MISMATCH");
    console.log("AGENCY_RELEASE_SMOKE " + JSON.stringify({checkedAt:new Date().toISOString(),deployedSha:EXPECTED,today,summaries,quarter:{count:quarterCount,expected:expectedQuarter},latestRecordedTour:maxTour._max.brokerTourDate,target:{sourceStatus:detail.item.sourceFreshness?.status,brokerCount:detail.item.attributes?.brokerCount,activeBrokers:detail.item.attributes?.activeBrokers,activeBrokerWindowDays:detail.item.attributes?.activeBrokerWindowDays,lastContractDate:detail.item.attributes?.lastContractDate},businessWrites:0}));
  } finally { await prisma.$disconnect(); }
}
main().catch(error=>{console.error("AGENCY_RELEASE_SMOKE_FAILED "+(error.safeCode || "UNEXPECTED"));process.exitCode=1;});
