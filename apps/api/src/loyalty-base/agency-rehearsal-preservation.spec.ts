import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = readFileSync(
  resolve(__dirname, "../../../../scripts/rehearse-loyalty-migration.sh"),
  "utf8",
).replace(/\r\n/g, "\n");
const fn = (name: string) =>
  source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))![0];
const bash =
  process.platform === "win32"
    ? "C:/Program Files/Git/bin/bash.exe"
    : "/bin/bash";
function run(mode: string) {
  return spawnSync(bash, ["-s"], {
    encoding: "utf8",
    timeout: 5000,
    input: `
set -eu
SCHEMA_CONTEXT=$(mktemp -d)
trap 'rm -rf -- "$SCHEMA_CONTEXT"' EXIT
REHEARSAL_ID=isolated-test
phase=before
mode=${mode}
fail() { echo "$*"; exit 1; }
docker() {
  query=""
  for arg do query="$arg"; done
  case "$query" in
    *information_schema.columns*)
      case "$query" in *agency_call_reviews*|*agency_campaign_outcomes*) echo ''; return;; esac
      echo 'id,name';;
    *to_regclass*) echo t;;
    *"SELECT count(*) FROM"*)
      if [ "$mode" = new_rows ]; then echo 1; else echo 0; fi;;
    *)
      if [ "$phase" = after ] && [ "$mode" = changed ]; then echo changed; else echo '2:stable'; fi;;
  esac
}
${fn("capture_operational_state")}
${fn("verify_operational_state")}
capture_operational_state
phase=after
verify_operational_state
`,
  });
}
describe("isolated rehearsal operational preservation gate", () => {
  it("accepts unchanged existing columns and empty newly added tables", () => {
    expect(run("unchanged").status).toBe(0);
  });
  it("fails when existing data fingerprints differ", () => {
    const r = run("changed");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("операционные данные");
  });
  it("fails when a newly created operational table contains records", () => {
    const r = run("new_rows");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("неожиданно содержит записи");
  });
  it("checks only the isolated container and never emits hashes or live data", () => {
    for (const name of [
      "capture_operational_state",
      "verify_operational_state",
    ]) {
      const body = fn(name);
      expect(body).toContain('docker exec "$REHEARSAL_ID"');
      expect(body).not.toContain("compose exec");
      expect(body).not.toMatch(/echo.*(before|after|columns|rows)/);
    }
    expect(source.indexOf("capture_operational_state\n")).toBeLessThan(
      source.indexOf("MIGRATION_TABLE_EXISTS="),
    );
    expect(source).toContain(
      "validate_clone_migration_history true\nverify_operational_state",
    );
  });
});
