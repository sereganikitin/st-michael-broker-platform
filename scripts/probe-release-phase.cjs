"use strict";
fetch("http://localhost:4000/api/health", { signal: AbortSignal.timeout(10000) })
  .then((response) => response.json())
  .then((json) => console.log("RELEASE_HEALTH " + JSON.stringify({ status: json.status, deployedSha: json.deployedSha })))
  .catch(() => { console.error("RELEASE_HEALTH_UNAVAILABLE"); process.exitCode = 1; });
