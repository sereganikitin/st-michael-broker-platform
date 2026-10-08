import { readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { AUTH_PASSWORD_COMPATIBILITY } from "./password-compatibility";

describe("production authentication rollback fence", () => {
  const root = resolve(__dirname, "../../../..");
  const source = readFileSync(resolve(root, "deploy-update.sh"), "utf8").replace(/\r\n/g, "\n");
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
  const functionSource = (name: string) => source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))![0];
  const guard = functionSource("previous_api_authentication_is_compatible");
  const rollback = functionSource("rollback_application");
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

  function runGuard(options: Record<string, string | number> = {}, completeRollback = false) {
    const values = {
      capability: 10, stopStatus: 0, inspectStatus: 0, running: "false",
      schemaStatus: 0, schema: "present", countStatus: 0, count: "0", ...options,
    };
    const input = `set -euo pipefail
${Object.entries(values).map(([key, value]) => `${key}=${quote(String(value))}`).join("\n")}
ROLLBACK_API_IMAGE=sha256:synthetic
ROLLBACK_OVERRIDE=synthetic.yml
stopped=0
capability_checked=0
loyalty_checked=0
replaced=0
docker() {
  case "$1" in
    run)
      test "$2" = --rm && test "$3" = --network && test "$4" = none || return 97
      test "$5" = --read-only && test "$6" = --entrypoint && test "$7" = node || return 97
      test "$8" = "$ROLLBACK_API_IMAGE" || return 97
      capability_checked=1
      return "$capability" ;;
    inspect)
      test "$stopped" = 1 || return 98
      test "$inspectStatus" = 0 || return "$inspectStatus"
      printf '%s' "$running" ;;
    *) return 97 ;;
  esac
}
rollback_compose() {
  case "$1" in
    stop)
      test "$*" = 'stop -t 30 api' || return 97
      test "$stopStatus" = 0 || return "$stopStatus"
      stopped=1 ;;
    exec)
      if [ "$3" = api ]; then printf '{"status":"ok"}'; return 0; fi
      test "$stopped" = 1 && test "$running" = false || return 98
      test "$3" = postgres && test "$4" = psql && test "$5" = -X || return 97
      query=\${!#}
      [[ "$query" == *'BEGIN READ ONLY;'* && "$query" == *"statement_timeout='5s'"* ]] || return 97
      if [[ "$query" == *'FROM pg_attribute'* ]]; then
        test "$schemaStatus" = 0 || return "$schemaStatus"
        printf '%s' "$schema"
      else
        [[ "$query" == *'SELECT COUNT(*) FROM public.brokers WHERE '* ]] || return 97
        [[ "$query" == *"password_hash LIKE 'bcrypt-sha256-v1\$%'"* ]] || return 97
        if [ "$schema" = present ]; then [[ "$query" == *'auth_version > 0 OR '* ]] || return 97;
        else [[ "$query" != *'auth_version'* ]] || return 97; fi
        test "$countStatus" = 0 || return "$countStatus"
        printf '%s' "$count"
      fi ;;
    -f)
      test "$capability_checked" = 1 && test "$loyalty_checked" = 1 || return 98
      replaced=1 ;;
    *) return 97 ;;
  esac
}
previous_api_schema_is_compatible() { test "$capability_checked" = 1 || return 98; loyalty_checked=1; }
reload_nginx_upstreams() { test "$replaced" = 1; }
curl() { test "$replaced" = 1; }
${guard}
${completeRollback ? rollback : ""}
if ${completeRollback ? "rollback_application" : "previous_api_authentication_is_compatible"}; then result=0; else result=1; fi
printf 'guard_stopped=%s guard_replaced=%s\\n' "$stopped" "$replaced"
exit "$result"
`;
    return spawnSync(bash, ["-s"], {
      input, encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
  }

  it("checks authentication before the independent loyalty guard and replacement", () => {
    expect(rollback.indexOf("if ! previous_api_authentication_is_compatible")).toBeLessThan(rollback.indexOf("if ! previous_api_schema_is_compatible"));
    expect(rollback.indexOf("if ! previous_api_schema_is_compatible")).toBeLessThan(rollback.indexOf("up -d"));
    expect(guard).toContain('"$ROLLBACK_API_IMAGE"');
    expect(guard).not.toMatch(/--env|--env-file|\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b|console\.|printenv/);
    expect(guard).toContain("--network none --read-only --entrypoint node");
    expect(guard).toContain("psql -X -v ON_ERROR_STOP=1");
    expect(guard.indexOf("stop -t 30 api")).toBeLessThan(guard.indexOf("FROM pg_attribute"));
    expect(guard.indexOf("current_api_running\" != \"false")).toBeLessThan(guard.indexOf("FROM pg_attribute"));
    expect(guard).not.toContain("SELECT password_hash");
  });

  it("parses the entire deploy Bash source without executing it", () => {
    const result = spawnSync(bash, ["-n"], { input: source, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("publishes a pure compiled marker at the Docker runtime path", () => {
    expect(AUTH_PASSWORD_COMPATIBILITY).toBe("bcrypt-sha256-v1+auth-version-v1");
    const marker = readFileSync(resolve(__dirname, "password-compatibility.ts"), "utf8");
    expect(marker).not.toMatch(/\b(import|require|process)\b/);
    const dockerfile = readFileSync(resolve(root, "docker/Dockerfile.api"), "utf8");
    expect(dockerfile).toContain("npm run build --workspace=apps/api");
    expect(dockerfile).toContain("/app /app");
    expect(guard).toContain("/app/apps/api/dist/auth/password-compatibility.js");
  });

  it.each([
    ["supported", { capability: 0 }, 0, "guard_stopped=0"],
    ["legacy without new state", {}, 0, "guard_stopped=1"],
    ["column absent without new hashes", { schema: "absent" }, 0, "guard_stopped=1"],
    ["positive authentication versions/new hashes", { count: "1" }, 1, "guard_stopped=1"],
    ["new hashes without auth column", { schema: "absent", count: "2" }, 1, "guard_stopped=1"],
    ["image inspection failed", { capability: 125 }, 1, "guard_stopped=0"],
    ["invalid marker", { capability: 20 }, 1, "guard_stopped=0"],
    ["stop failure", { stopStatus: 1 }, 1, "guard_stopped=0"],
    ["still running", { running: "true" }, 1, "guard_stopped=1"],
    ["unknown running state", { running: "" }, 1, "guard_stopped=1"],
    ["inspect failure", { inspectStatus: 1 }, 1, "guard_stopped=1"],
    ["schema query failure", { schemaStatus: 1 }, 1, "guard_stopped=1"],
    ["invalid schema result", { schema: "invalid" }, 1, "guard_stopped=1"],
    ["aggregate query failure", { countStatus: 1 }, 1, "guard_stopped=1"],
    ["nonnumeric aggregate", { count: "bcrypt-sha256-v1$privatehash" }, 1, "guard_stopped=1"],
    ["negative aggregate", { count: "-1" }, 1, "guard_stopped=1"],
    ["multiple aggregate rows", { count: "0\n1" }, 1, "guard_stopped=1"],
    ["oversized aggregate", { count: "9".repeat(20) }, 1, "guard_stopped=1"],
  ])("%s fails closed or authorizes only a stopped legacy API", (_name, options, status, stopped) => {
    const result = runGuard(options);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.stdout).toContain(stopped);
    expect(result.stdout + result.stderr).not.toContain("privatehash");
  });

  it.each([[0, "0", 0], [10, "0", 0], [10, "1", 1], [125, "0", 1]])(
    "actual rollback flow (capability %s, count %s) cannot bypass the guard",
    (capability, count, status) => {
      const result = runGuard({ capability, count }, true);
      expect(result.status).toBe(status);
      expect(result.stdout).toContain(`guard_replaced=${status === 0 ? 1 : 0}`);
    },
  );

  const inspection = guard.match(/-e '\n([\s\S]*?)\n        ' >\/dev\/null/)![1];
  it.each([
    ["supported", "return {isFile:()=>true}", "return {AUTH_PASSWORD_COMPATIBILITY:'bcrypt-sha256-v1+auth-version-v1'}", 0],
    ["absent", "throw Object.assign(new Error('untrusted secret'),{code:'ENOENT'})", "throw new Error('not reached')", 10],
    ["unreadable", "throw Object.assign(new Error('untrusted secret'),{code:'EACCES'})", "throw new Error('not reached')", 20],
    ["symlink/nonfile", "return {isFile:()=>false}", "throw new Error('not reached')", 20],
    ["wrong marker", "return {isFile:()=>true}", "return {AUTH_PASSWORD_COMPATIBILITY:'older'}", 20],
    ["module failure", "return {isFile:()=>true}", "throw new Error('untrusted secret')", 20],
  ])("real Node marker inspector distinguishes %s without raw output", (_name, filesystem, module, status) => {
    const result = spawnSync(process.execPath, ["-e", `
      global.require = (name) => name === 'fs'
        ? {lstatSync: () => {${filesystem}}}
        : (() => {${module}})();
      ${inspection}
    `], { encoding: "utf8", timeout: 5000, env: {} });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toBe("");
  });
});
