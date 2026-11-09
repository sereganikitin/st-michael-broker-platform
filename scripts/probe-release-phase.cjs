"use strict";
const { spawnSync } = require("node:child_process");
const builds = (service) => Number(spawnSync("pgrep", ["-fc", `[d]ocker compose.*build ${service}`], { encoding: "utf8" }).stdout.trim()) || 0;
console.log("RELEASE_PHASE " + JSON.stringify({ apiBuilds: builds("api"), webBuilds: builds("web") }));
fetch("http://localhost:4000/api/health", { signal: AbortSignal.timeout(10000) })
  .then((response) => response.json())
  .then((json) => console.log("RELEASE_HEALTH " + JSON.stringify({ status: json.status, deployedSha: json.deployedSha })))
  .catch(() => { console.error("RELEASE_HEALTH_UNAVAILABLE"); process.exitCode = 1; });
