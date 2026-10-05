import { readFileSync } from "fs";
import { resolve } from "path";

const repositoryRoot = resolve(__dirname, "../../../..");
const source = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

describe("public web origin deployment contract", () => {
  it("uses the same validated origin for CORS and authentication emails", () => {
    const main = source("apps/api/src/main.ts");
    const auth = source("apps/api/src/auth/auth.service.ts");
    expect(main).toContain("origin: getPublicWebOrigin()");
    expect(auth).toContain("getPublicWebOrigin()");
    expect(auth).not.toContain('"https://72.56.241.199"');
  });

  it("stages the canonical domain before compose validation without overriding rollback env", () => {
    const deploy = source("deploy-update.sh");
    const pin = deploy.indexOf(
      'update_env_value "WEB_URL" "https://broker.stmichael.ru"',
    );
    const clearOverride = deploy.indexOf("unset WEB_URL", pin);
    const validate = deploy.indexOf(
      'docker compose --env-file "$ENV_STAGING_FILE" config --quiet',
    );
    expect(pin).toBeGreaterThan(deploy.indexOf("update_env_value()"));
    expect(clearOverride).toBeGreaterThan(pin);
    expect(validate).toBeGreaterThan(clearOverride);
    expect(deploy).toContain('mv -- "$ENV_STAGING_FILE" "$SERVER_ENV_FILE"');
  });

  it("does not recommend legacy IP addresses in compose or development examples", () => {
    expect(source("docker-compose.yml")).toContain(
      "WEB_URL: ${WEB_URL:-https://broker.stmichael.ru}",
    );
    expect(source(".env.example")).toContain("WEB_URL=http://localhost:3000");
    expect(source(".env.example")).not.toContain("WEB_URL=http://72.56.241.199");
  });
});
