import { readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { parse } from "yaml";

describe("read-only old production build image inventory", () => {
  const root = resolve(__dirname, "../../../..");
  const source = readFileSync(resolve(root, ".github/workflows/inspect-production-old-build-images.yml"), "utf8");
  const workflow = parse(source);
  const run = workflow.jobs.inspect.steps[1].run.replace(/\r\n/g, "\n");
  const remote = run.split("<<'REMOTE'\n")[1].split("\nREMOTE")[0];
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
  const python = process.platform === "win32"
    ? "C:/Users/PC-OpenClaw/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
    : "python3";
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const functionSource = (name: string) => remote.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))![0];
  const runIsolated = (script: string) => spawnSync(bash, ["-s"], {
    input: `set -euo pipefail\n${script}\n`, encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  const id = "sha256:" + "a".repeat(64);
  const another = "sha256:" + "b".repeat(64);
  const now = 1801958400;

  it("pins canonical current source, host, live SHA and shared existing lock", () => {
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(workflow.jobs.inspect.environment).toBe("production");
    expect(source).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(run).toContain('test "$master_sha" = "$EXPECTED_SHA"');
    expect(run).toContain('test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"');
    expect(run).toContain("-o StrictHostKeyChecking=yes");
    expect(remote).toContain("exec 9</tmp/st-michael-production-deploy.lock");
    expect(remote).toContain("flock -s -n 9");
    expect(remote).toContain('test "$(git rev-parse HEAD)" = "$expected_deployed_sha"');
    expect(source).not.toContain("appleboy/");
  });

  it("never deletes/applies/changes server files, services, images or DB rows", () => {
    const commands = remote.split("\n").filter((line: string) => !line.trim().startsWith("#")).join("\n");
    expect(commands).not.toMatch(/\b(rm|rmi|mv|cp|truncate|unlink|mktemp|mkdir|chmod|chown|tee|prune|vacuum)\b/);
    expect(commands).not.toMatch(/docker\s+(restart|start|stop|kill|run|build|pull|push|tag|compose)|image\s+(rm|prune|tag|load|save|import)/);
    expect(commands).not.toMatch(/git\s+(fetch|reset|clean|checkout|pull|push)/);
    expect(commands).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/);
    expect(commands).not.toMatch(/\b(set -x|printenv|env|eval|source)\b|\.Config\.Env|\.Mounts|args=|cmdline/);
    expect(remote).toContain("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'");
    expect(remote).toContain("cleanup_performed=false");
    expect(remote).toContain("inspection_only=true");
    expect(remote).toContain("daemon_prune_completion_verified=false");
  });

  it("parses the full actual Bash script without executing it", () => {
    const result = spawnSync(bash, ["-n"], { input: run, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("captures all stopped/running containers, all tags and unique metadata before reporting", () => {
    expect(remote).toContain("docker ps -aq --no-trunc");
    expect(remote).toContain(".State.StartedAt");
    expect(remote).toContain(".RestartCount");
    expect(remote).not.toContain("< <(docker ps");
    expect(remote).toContain("{{.Repository}}:{{.Tag}}|{{.ID}}");
    expect(remote).toContain('test "$(containers_snapshot)" = "$containers_before"');
    expect(remote).toContain('test "$(tags_snapshot)" = "$tags_before"');
    expect(remote).toContain('test "$(metadata_snapshot)" = "$metadata_before"');
    expect(remote).toContain("tolower($1) ~ /(rollback|recovery|backup)/");
    expect(remote).toContain('"$project-$service:latest"');
    expect(remote.indexOf("inventory_sha256=%s")).toBeGreaterThan(remote.lastIndexOf("assert_health || exit 1"));
  });

  it("bounds physical metadata and checks unique image IDs only once", () => {
    const metadata = functionSource("metadata_snapshot");
    expect(metadata).toContain("/var/backups/stmichael/releases");
    expect(metadata).toContain('test -d "$dir" -a ! -L "$dir"');
    expect(metadata).toContain('test -f "$record" -a ! -L "$record"');
    expect(metadata).toContain('test "$(readlink -f -- "$record")" = "$record"');
    expect(metadata).toContain("NR > 2000 {exit 1}");
    expect(metadata).toContain('test "$size" -le 65536');
    for (const key of ["previous_api_image", "previous_web_image", "previous_nginx_image"]) expect(metadata).toContain(key);
    expect(metadata).toContain("++seen[$1] != 1");
    expect(metadata).not.toContain("docker");
    expect(remote).toContain("all_ids=$(printf '%s\\n' \"$tags_before\" | awk -F'|' '{print $2}' | sort -u)");
    expect(remote).toContain('while IFS= read -r id; do');
    expect(remote).toContain('done <<< "$all_ids"');
    expect(remote).toContain("candidate_size_upper_bound_bytes");
  });

  it("requires exact Compose image provenance and refuses registry digests", () => {
    expect(remote).toContain('"com.docker.compose.project"');
    expect(remote).toContain('"com.docker.compose.service"');
    expect(remote).toContain('digests = data.get("RepoDigests")');
    expect(remote).toContain('[ "$image_project" = "$project" ] && [ "$digests" = \'[]\' ]');
    expect(remote).toContain('case "$image_service" in api|web)');
    expect(remote).toContain('test "$(printf \'%s\' "$candidate" | awk -F\'|\' \'{print $4}\')" = "$image_service"');
  });

  it.each(["no_config", "null_config", "no_labels", "null_labels", "unrelated_labels"])("inspects %s without granting tag-based provenance", (scenario) => {
    const inspect = functionSource("inspect_image_record");
    expect(inspect).not.toContain("--format");
    expect(inspect).toContain("python3 -B -c");
    const image: any = { Id: id, Created: "2026-09-01T00:00:00Z", Size: 123, RepoDigests: null };
    if (scenario === "null_config") image.Config = null;
    if (scenario === "no_labels") image.Config = {};
    if (scenario === "null_labels") image.Config = { Labels: null };
    if (scenario === "unrelated_labels") image.Config = { Labels: { owner: "synthetic-private@example.test" } };
    const record = `${id}|2026-09-01T00:00:00Z|123|null|null|[]`;
    const result = runIsolated(`timeout() { shift; "$@"; }
python3() { command ${quote(python)} "$@"; }
docker() {
  command test "$1 $2" = 'image inspect' && command test "$#" -eq 3 && command test "$3" = ${quote(id)} || return 99
  printf '%s\\n' ${quote(JSON.stringify([image]))}
}
${inspect}
inspect_image_record ${quote(id)}`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(record);
    expect(result.stderr).toBe("");
    // Execute the actual provenance branch with missing labels. A plausible
    // project build tag alone must never make this image a candidate.
    const branch = remote.slice(remote.indexOf('if [ "$image_project" = "$project" ]'), remote.indexOf('image_records+='));
    const candidate = runIsolated(`image_project=''; image_service=''; project=unit; digests='[]'; candidate=''
id=${quote(id)}; created_epoch=1800000000; size=123; image_tags='unit-api:old'; protected_ids=''; inspection_epoch=${now}
${functionSource("candidate_record")}
${branch}
printf '%s' "$candidate"`);
    expect(candidate.status).toBe(0);
    expect(candidate.stdout).toBe("");
    expect(candidate.stderr).toBe("");
  });

  it.each([
    ["empty", []], ["multiple", [{}, {}]], ["object_root", {}],
    ["wrong_id", [{ Id: another, Created: "2026-09-01T00:00:00Z", Size: 1 }]],
    ["invalid_created", [{ Id: id, Created: { private: "synthetic-private@example.test" }, Size: 1 }]],
    ["size_bool", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: true }]],
    ["size_float", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 1.5 }]],
    ["size_string", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: "1" }]],
    ["config_array", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 1, Config: [] }]],
    ["labels_array", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 1, Config: { Labels: [] } }]],
    ["project_number", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 1, Config: { Labels: { "com.docker.compose.project": 1 } } }]],
    ["digests_object", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 1, RepoDigests: {} }]],
    ["digests_nonstrings", [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 1, RepoDigests: [false] }]],
  ])("fails closed on actual Python JSON projection scenario=%s without private output", (_scenario, data) => {
    const result = runIsolated(`timeout() { shift; "$@"; }
python3() { command ${quote(python)} "$@"; }
docker() { printf '%s\\n' ${quote(JSON.stringify(data))}; }
${functionSource("inspect_image_record")}
inspect_image_record ${quote(id)}`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("inventory_guard_failed=image_inspection\nimage_inspection_error_kind=record_invalid\nimage_inspection_exit_code=1\n");
  });

  it("uses actual Python projection and safely encodes delimiters while discarding unrelated private fields", () => {
    const fixture = [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 123, Config: {
      Env: ["SECRET=synthetic-private@example.test"],
      Labels: { "com.docker.compose.project": "foreign|project\nname", "com.docker.compose.service": "api", private: "synthetic-private@example.test" },
    }, RepoDigests: ["registry|digest"] }];
    const result = runIsolated(`timeout() { shift; "$@"; }
python3() { command ${quote(python)} "$@"; }
docker() { printf '%s\\n' ${quote(JSON.stringify(fixture))}; }
${functionSource("inspect_image_record")}
inspect_image_record ${quote(id)}`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const fields = result.stdout.trim().split("|");
    expect(fields).toHaveLength(6);
    expect(JSON.parse(fields[3])).toBe("foreign|project\nname");
    expect(JSON.parse(fields[5])).toEqual(["registry|digest"]);
    expect(result.stdout).not.toContain("synthetic-private");
  });

  it.each(["invalid_json", "duplicate_key", "non_json_constant", "response_too_large"])("bounds malformed raw inspect %s before any record output", (scenario) => {
    const payload = scenario === "duplicate_key" ? `[{"Id":"${id}","Id":"${another}"}]`
      : scenario === "non_json_constant" ? `[{"Id":"${id}","Created":"2026-09-01T00:00:00Z","Size":1,"private":NaN}]`
      : "synthetic-private@example.test";
    const result = runIsolated(`scenario=${quote(scenario)}
timeout() { shift; "$@"; }
python3() { command ${quote(python)} "$@"; }
docker() { if [ "$scenario" = response_too_large ]; then printf '%2097153s' ''; else printf '%s\\n' ${quote(payload)}; fi; }
${functionSource("inspect_image_record")}
inspect_image_record ${quote(id)}`);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`inventory_guard_failed=image_inspection\nimage_inspection_error_kind=${scenario === "response_too_large" ? "response_too_large" : "record_invalid"}\nimage_inspection_exit_code=${scenario === "response_too_large" ? 42 : 1}\n`);
  });

  it.each([
    { name: "empty", digests: [] }, { name: "null", digests: null },
    { name: "absent", digests: undefined }, { name: "registry", digests: ["registry.example/image@sha256:synthetic"] },
  ])("retains exact known Compose provenance and registry-digest exclusion for $name", ({ digests }) => {
    const fixture = [{ Id: id, Created: "2026-09-01T00:00:00Z", Size: 123, Config: {
      Labels: { "com.docker.compose.project": "unit", "com.docker.compose.service": "api" },
    }, RepoDigests: digests }];
    const result = runIsolated(`timeout() { shift; "$@"; }
python3() { command ${quote(python)} "$@"; }
docker() { printf '%s\\n' ${quote(JSON.stringify(fixture))}; }
${functionSource("inspect_image_record")}
inspect_image_record ${quote(id)}`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const fields = result.stdout.trim().split("|");
    expect(fields).toHaveLength(6);
    const branch = remote.slice(remote.indexOf('if [ "$image_project" = "$project" ]'), remote.indexOf('image_records+='));
    const candidate = runIsolated(`image_project=${quote(JSON.parse(fields[3]))}; image_service=${quote(JSON.parse(fields[4]))}; project=unit; digests=${quote(fields[5])}; candidate=''
id=${quote(id)}; created_epoch=1800000000; size=123; image_tags='unit-api:old'; protected_ids=''; inspection_epoch=${now}
${functionSource("candidate_record")}
${branch}
printf '%s' "$candidate"`);
    expect(candidate.status).toBe(0);
    expect(Boolean(candidate.stdout)).toBe(!digests || digests.length === 0);
    if (candidate.stdout) expect(candidate.stdout).toBe(`${id}|1800000000|123|api|unit-api:old`);
  });

  it.each([
    [1, "nil pointer evaluating config synthetic-private@example.test", "template_nil"],
    [1, "error calling index: index of untyped nil synthetic-private@example.test", "template_nil"],
    [1, "template parsing error synthetic-private@example.test", "template_error"],
    [1, 'template parsing error map has no entry for key "Config" synthetic-private@example.test', "template_missing_config"],
    [1, 'template parsing error map has no entry for key "Labels" synthetic-private@example.test', "template_missing_labels"],
    [1, 'template parsing error map has no entry for key "RepoDigests" synthetic-private@example.test', "template_missing_repo_digests"],
    [1, 'template parsing error map has no entry for key "ArbitraryPrivate" synthetic-private@example.test', "template_missing_key"],
    [1, "template parsing error can't evaluate field Config synthetic-private@example.test", "template_field_type"],
    [1, 'template parsing error function "ArbitraryPrivate" not defined synthetic-private@example.test', "template_function"],
    [1, 'template parsing error unclosed action synthetic-private@example.test', "template_syntax"],
    [1, 'template parsing error error calling json synthetic-private@example.test', "template_json"],
    [1, "Error: No such image: synthetic-private@example.test", "image_not_found"],
    [1, "permission denied synthetic-private@example.test", "permission_denied"],
    [1, "Cannot connect to the Docker daemon synthetic-private@example.test", "daemon_unavailable"],
    [124, "private timeout detail synthetic-private@example.test", "timeout"],
    [137, "private arbitrary detail synthetic-private@example.test", "unknown"],
  ])("sanitizes failed image inspection exit=%s into a fixed category", (status, message, kind) => {
    const result = runIsolated(`timeout() { shift; "$@"; }
docker() { printf '%s\\n' ${quote(message)} >&2; return ${status}; }
${functionSource("inspect_image_record")}
inspect_image_record ${quote(id)}`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`inventory_guard_failed=image_inspection\nimage_inspection_error_kind=${kind}\nimage_inspection_exit_code=${status}\n`);
    expect(result.stderr).not.toContain("synthetic-private");
  });

  it.each([
    [604800, "unit-api:20260901", "", 0, true],
    [604801, "unit-web:20260901", another, 0, true],
    [604799, "unit-api:old", "", 0, false],
    [604800, "unit-api:old", id, 0, false],
    [604800, "unit-api:latest", "", 0, false],
    [604800, "unit-web:latest", "", 0, false],
    [604800, "unit-api:current", "", 0, false],
    [604800, "unit-api:rollback-20260901", "", 0, false],
    [604800, "unit-api:ROLLBACK-20260901", "", 0, false],
    [604800, "unit-api:recovery-20260901", "", 0, false],
    [604800, "unit-api:backup-20260901", "", 0, false],
    [604800, "foreign-api:old", "", 0, false],
    [604800, "unit-redis:old", "", 0, false],
    [604800, "st-michael-rollback-api:20260901-000000", "", 0, false],
    [604800, "unit-api:old\nst-michael-rollback-api:old", "", 0, false],
    [604800, "unit-api:old\nforeign:old", "", 0, false],
    [604800, "<none>:<none>", "", 0, false],
    [604800, "unit-api:bad;command", "", 1, false],
    [-1, "unit-api:old", "", 1, false],
  ])("evaluates age=%s tags=%s protection without real Docker", (age, tags, protectedIds, expectedStatus, expectedCandidate) => {
    const args = [id, String(now - age), "123", tags, protectedIds, "unit", String(now)].map(quote).join(" ");
    const result = runIsolated(`${functionSource("candidate_record")}\ncandidate_record ${args}`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(expectedStatus);
    expect(Boolean(result.stdout.trim())).toBe(expectedCandidate);
    if (expectedCandidate) expect(result.stdout).toContain(`${id}|${now - age}|123|`);
  });

  it.each(["docker", " docker-compose", "docker-buildx", "buildx", "buildctl"])("refuses concurrent CLI %s using comm only", (name) => {
    const result = runIsolated(`timeout() { shift; "$@"; }\nps() { printf '%s\\n' ${quote(name)}; }\n${functionSource("assert_no_docker_cli")}\nassert_no_docker_cli`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active_docker_cli_observed=true");
    expect(result.stderr).toBe("active_docker_cli_observed=true\nInventory refused while another Docker CLI is active\n");
  });

  it.each(["dockerd", "sshd\nbash\nps", "buildkitd"])("allows daemon/background comm %s without claiming daemon completion", (names) => {
    const result = runIsolated(`timeout() { shift; "$@"; }\nps() { printf '%s\\n' ${quote(names)}; }\n${functionSource("assert_no_docker_cli")}\nassert_no_docker_cli`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails closed when process enumeration fails", () => {
    const result = runIsolated(`timeout() { shift; "$@"; }\nps() { return 1; }\n${functionSource("assert_no_docker_cli")}\nassert_no_docker_cli`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Process inventory failed");
  });

  it("does not publish arbitrary candidate tags or raw private inventories", () => {
    const outputs = remote.split("\n").filter((line: string) => /printf|echo/.test(line) && !line.includes(" | ")).join("\n");
    expect(outputs).not.toContain("$candidate_tag");
    expect(outputs).not.toMatch(/printf[^\n]*\$(?:containers_before|tags_before|metadata_before|image_records|protected_ids|candidate)\b/);
    expect(outputs).toContain("candidate_service=");
    expect(outputs).not.toContain("candidate_tag_sha256");
  });

  it.each(["none", "container", "rollback", "metadata"])("keeps protection extraction fail-closed at %s", (failure) => {
    const third = "sha256:" + "c".repeat(64);
    const script = `failure=${quote(failure)}
awk() {
  case "$failure:$*" in
    container:*'print $2'*) return 1;;
    rollback:*'tolower'*) return 1;;
    metadata:*'print $3'*) return 1;;
  esac
  command awk "$@"
}
${functionSource("protected_ids_snapshot")}
protected_ids_snapshot ${quote(`container|${id}`)} ${quote(`st-michael-rollback-api:old|${another}`)} ${quote(`record|hash|${third}`)} ${quote(another)}`;
    const result = runIsolated(script);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(failure === "none" ? 0 : 1);
    if (failure === "none") expect(result.stdout.trim().split("\n")).toEqual([id, another, third]);
    else expect(result.stdout).toBe("");
  });

  it.each(["none", "count", "hash", "df", "invalid_metric", "invalid_hash"])("validates every attestation capture before output for %s", (failure) => {
    const script = `failure=${quote(failure)}
candidates=${quote(`${id}|1|123|api|unit-api:synthetic-private`)}
all_ids=${quote(id)}
protected_ids=${quote(another)}
awk() { if [ "$failure" = count ]; then return 1; fi; command awk "$@"; }
sha256sum() { case "$failure" in hash) return 1;; invalid_hash) printf 'invalid\\n';; *) printf '%s\\n' ${quote("d".repeat(64))};; esac; }
df() { case "$failure" in df) return 1;; invalid_metric) printf 'header\\nfs 1 2 invalid 1%% /\\n';; *) printf 'header\\nfs 10000 1000 9000 10%% /\\n';; esac; }
${functionSource("prepare_attestation_metrics")}
prepare_attestation_metrics || exit 1
printf 'trusted_attestation=true\\n'`;
    const result = runIsolated(script);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(failure === "none" ? 0 : 1);
    expect(result.stdout).toBe(failure === "none" ? "trusted_attestation=true\n" : "");
    const publish = remote.indexOf("printf 'inventory_sha256=%s");
    expect(remote.indexOf("prepare_attestation_metrics ||")).toBeLessThan(publish);
    expect(remote.slice(publish)).not.toMatch(/printf[^\n]*\$\((?!\()/);
  });

  it("prints fixed stage evidence even when an explicit guard exits", () => {
    const header = remote.slice(0, remote.indexOf("export LC_ALL"));
    const result = runIsolated(`${header}\nset_stage synthetic_guard\nfalse || exit 1`);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("inventory_failed_stage=synthetic_guard\ninventory_exit_code=1\n");
    for (const marker of ["local_validation", "local_master_identity", "local_https_health", "local_source_ancestry", "local_ssh_host_identity", "local_pinned_ssh", "remote_shared_lock", "remote_docker_cli_gate", "remote_runtime_identity", "remote_https_health", "remote_rollback_metadata", "remote_unique_image_inspection", "remote_inventory_recheck", "remote_attestation"])
      expect(run).toContain(`set_stage ${marker}`);
  });

  it.each([
    ["valid", 0], ["missing_dir", 1], ["symlink_dir", 1], ["symlink_file", 1],
    ["missing_key", 1], ["duplicate_key", 1], ["invalid_id", 1],
    ["large_file", 1], ["empty", 1], ["too_many", 1], ["find_failure", 1],
  ])("checks metadata scenario=%s entirely with mocked filesystem", (scenario, status) => {
    const valid = `previous_api_image=${id}\nprevious_web_image=${another}\nprevious_nginx_image=${another}\n`;
    let record = valid;
    if (scenario === "missing_key") record = `previous_api_image=${id}\nprevious_web_image=${another}\n`;
    if (scenario === "duplicate_key") record += `previous_api_image=${id}\n`;
    if (scenario === "invalid_id") record = valid.replace(id, "invalid");
    const script = `scenario=${quote(scenario)}
test() {
  case "$*" in
    *'/var/backups/stmichael/releases'*)
      case "$scenario:$*" in missing_dir:*|symlink_dir:*|symlink_file:*release-one.txt*) return 1;; esac
      return 0;;
    *) command test "$@";;
  esac
}
readlink() { printf '%s\\n' "\${@: -1}"; }
timeout() { shift; "$@"; }
find() {
  case "$scenario" in find_failure) return 1;; empty) return 0;; too_many) for ((i=0;i<2001;i++)); do printf 'release-%04d.txt\\n' "$i"; done;; *) printf 'release-one.txt\\n';; esac
}
stat() { if [ "$scenario" = large_file ]; then printf '65537\\n'; else printf '300\\n'; fi; }
sha256sum() { printf '%s  synthetic-file\\n' ${quote("c".repeat(64))}; }
awk() {
  case "\${@: -1}" in /var/backups/stmichael/releases/*) printf '%s' ${quote(record)} | command awk -F= "$2";; *) command awk "$@";; esac
}
${functionSource("metadata_snapshot")}
metadata_snapshot`;
    const result = runIsolated(script);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status === 0) {
      expect(result.stdout).toContain(`release-one.txt|${"c".repeat(64)}|${id}`);
      expect(result.stdout.trim().split("\n")).toHaveLength(3);
    }
  });
});
