#!/usr/bin/env node
// Scheduled/admin/manual synchronization shares the replacement contract.
// Do not reintroduce the old archive or scan the public share root.
require('./materials-new-version').main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
