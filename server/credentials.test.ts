import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCredentials,
  credentialsPath,
  DEFAULT_INSTANCE_URL,
  DEFAULT_WORKSPACE_SLUG,
  resolveCredentials,
  saveCredentials,
} from "./credentials";

describe("credentials", () => {
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "plane-to-paseo-"));
    process.env.PASEO_HOME = home;
    for (const key of ["PLANE_API_KEY", "PLANE_API_TOKEN", "PLANE_URL", "PLANE_WORKSPACE"]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("resolves nothing when neither env nor file exist", () => {
    expect(resolveCredentials()).toBeNull();
    expect(credentialsPath()).toBe(
      path.join(home, "plugins", "plane-to-paseo", "credentials.json"),
    );
  });

  it("saves a 0600 file with defaults and reads it back, then clears it", () => {
    saveCredentials({ token: "  plane_api_secret \n" });
    expect(resolveCredentials()).toEqual({
      token: "plane_api_secret",
      instanceUrl: DEFAULT_INSTANCE_URL,
      workspaceSlug: DEFAULT_WORKSPACE_SLUG,
      source: "file",
    });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    clearCredentials();
    expect(resolveCredentials()).toBeNull();
    clearCredentials(); // idempotent
  });

  it("persists a custom instance and workspace", () => {
    saveCredentials({ token: "t", instanceUrl: "https://plane.example", workspaceSlug: "acme" });
    expect(resolveCredentials()).toMatchObject({
      instanceUrl: "https://plane.example",
      workspaceSlug: "acme",
    });
  });

  it("prefers the environment over the file", () => {
    saveCredentials({ token: "from-file" });
    process.env.PLANE_API_KEY = "from-env";
    process.env.PLANE_WORKSPACE = "other";
    expect(resolveCredentials()).toEqual({
      token: "from-env",
      instanceUrl: DEFAULT_INSTANCE_URL,
      workspaceSlug: "other",
      source: "env",
    });
  });

  it("ignores a corrupt file", () => {
    saveCredentials({ token: "x" });
    writeFileSync(credentialsPath(), "{not json");
    expect(resolveCredentials()).toBeNull();
  });
});
