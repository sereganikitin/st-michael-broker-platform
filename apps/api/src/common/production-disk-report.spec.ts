import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

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

  it("never mutates server files, containers, logs, backups or DB rows", () => {
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
