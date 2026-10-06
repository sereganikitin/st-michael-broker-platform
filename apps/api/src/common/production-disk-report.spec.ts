import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import { runInNewContext } from "vm";

describe("production disk report safety", () => {
  const root = resolve(__dirname, "../../../..");
  const source = readFileSync(resolve(root, ".github/workflows/server-disk-report.yml"), "utf8");
  const workflow = parse(source);
  const script = workflow.jobs.report.steps[1].run;
  const remote = script.slice(script.indexOf("<<'REMOTE'"));

  it("pins exact canonical source, SSH host and read-only production lock", () => {
    expect(workflow.jobs.report.environment).toBe("production");
    expect(workflow.concurrency.group).toBe("production-deploy");
    expect(source).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(source).toContain('test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"');
    expect(source).toContain("-o StrictHostKeyChecking=yes");
    expect(source).toContain('exec 9</tmp/st-michael-production-deploy.lock');
    expect(source).toContain("flock -s -n 9");
    expect(source).toContain('test "$(git rev-parse HEAD)" = "$expected_deployed_sha"');
    expect(source).not.toContain("appleboy/");
  });

  it("reports five filesystems and aggregate DB reserve only", () => {
    for (const label of ["root", "deploy", "release_context", "docker_root", "backup"]) {
      expect(remote).toContain(`report_fs ${label} `);
    }
    expect(remote).toContain("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'");
    expect(remote).toContain("pg_database_size(current_database())");
    expect(remote).toContain("8589934592 + database_size_bytes + 67108864");
    expect(remote).toContain("docker system df");
    expect(remote).not.toMatch(/SELECT\s+\*/i);
    expect(remote).not.toContain(".Config.Env");
  });

  it.each([
    [undefined, false, false], ["", false, false], ["short", true, false],
    ["replace-with-a-stable-random-secret-at-least-32-bytes", true, false],
    ["test-only-key.ABC_123~+/=-stable-value", true, true],
    ["x".repeat(32) + "\n::warning::private", true, false],
    ["x".repeat(32) + "\n", true, false], ["я".repeat(32), true, false],
  ])("reports only booleans for the attested contact key without disclosure or mutation", (key, configured, valid) => {
    const nodeStart = remote.indexOf("docker exec -i st-michael-api node <<'CONTACT_GATE_FLAGS'");
    expect(nodeStart).toBeGreaterThan(remote.indexOf('test "$(docker exec st-michael-api sh'));
    const inline = remote.slice(nodeStart).match(/CONTACT_GATE_FLAGS'\n([\s\S]*?)\n\s*CONTACT_GATE_FLAGS/)![1];
    const log = jest.fn();
    const env = Object.freeze({ BROKER_CONTACT_GATE_HMAC_KEY: key });
    runInNewContext(inline, { process: { env }, console: { log } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      brokerContactGateKeyConfigured: configured, brokerContactGateKeyValidAscii: valid,
    });
    if (key) expect(log.mock.calls[0][0]).not.toContain(key);
    expect(inline).not.toMatch(/digest|hash|substring|slice|write|require|fetch|spawn/);
    expect(env.BROKER_CONTACT_GATE_HMAC_KEY).toBe(key);
  });

  it("never mutates server files, containers, logs, backups or DB rows", () => {
    expect(remote).toContain('test -f .env -a ! -L .env');
    expect(remote).toContain('test "$(readlink -f -- .env)" = "$deploy_root/.env"');
    expect(remote).toContain('grep -qF -- BROKER_CONTACT_GATE_HMAC_KEY .env');
    expect(remote).toContain('test "$grep_status" -eq 1 || exit 1');
    expect(remote).not.toMatch(/\b(rm|mv|cp|truncate|mktemp)\b/);
    expect(remote).not.toMatch(/prune|vacuum-size|git fetch|git reset|docker (restart|start|stop|rm|run|cp)/);
    expect(remote).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/);
    expect(remote).not.toContain("pg_dump");
    expect(remote).toContain("find /tmp -maxdepth 1");
    expect(remote).toContain('test ! -L "$candidate"');
    expect(remote).toContain('if [ "$count" -gt 50 ]');
    expect(remote).not.toContain("journalctl -n");
    expect(remote).toContain("inspection_only=true");
  });
});
