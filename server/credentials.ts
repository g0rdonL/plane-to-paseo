import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Plane API token never leaves the daemon. Resolution order:
 *   1. PLANE_API_KEY (or PLANE_API_TOKEN) in the daemon environment, with optional PLANE_URL and
 *      PLANE_WORKSPACE
 *   2. $PASEO_HOME/plugins/plane-to-paseo/credentials.json, written by the settings screen
 *
 * The instance URL and workspace slug live beside the token because only the daemon calls Plane.
 */

export const DEFAULT_INSTANCE_URL = "https://plane.aight.to";
export const DEFAULT_WORKSPACE_SLUG = "aight";

export type CredentialSource = "env" | "file";

export interface ResolvedCredentials {
  token: string;
  instanceUrl: string;
  workspaceSlug: string;
  source: CredentialSource;
}

interface StoredCredentials {
  token: string;
  instanceUrl?: string;
  workspaceSlug?: string;
}

const TOKEN_ENV_KEYS = ["PLANE_API_KEY", "PLANE_API_TOKEN"] as const;

export function credentialsDir(): string {
  const home = process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
  return path.join(home, "plugins", "plane-to-paseo");
}

export function credentialsPath(): string {
  return path.join(credentialsDir(), "credentials.json");
}

function readStored(): StoredCredentials | null {
  const file = credentialsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredCredentials>;
    if (typeof parsed.token !== "string" || !parsed.token.trim()) return null;
    return {
      token: parsed.token.trim(),
      instanceUrl: typeof parsed.instanceUrl === "string" ? parsed.instanceUrl : undefined,
      workspaceSlug: typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined,
    };
  } catch (error) {
    console.error(
      `[plane-to-paseo] credentials file is not valid JSON: ${(error as Error).message}`,
    );
    return null;
  }
}

export function resolveCredentials(): ResolvedCredentials | null {
  for (const key of TOKEN_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      return {
        token: value,
        instanceUrl: process.env.PLANE_URL?.trim() || DEFAULT_INSTANCE_URL,
        workspaceSlug: process.env.PLANE_WORKSPACE?.trim() || DEFAULT_WORKSPACE_SLUG,
        source: "env",
      };
    }
  }
  const stored = readStored();
  if (!stored) return null;
  return {
    token: stored.token,
    instanceUrl: stored.instanceUrl?.trim() || DEFAULT_INSTANCE_URL,
    workspaceSlug: stored.workspaceSlug?.trim() || DEFAULT_WORKSPACE_SLUG,
    source: "file",
  };
}

export function saveCredentials(credentials: StoredCredentials): void {
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath();
  const payload: StoredCredentials = { token: credentials.token.trim() };
  if (credentials.instanceUrl) payload.instanceUrl = credentials.instanceUrl.trim();
  if (credentials.workspaceSlug) payload.workspaceSlug = credentials.workspaceSlug.trim();
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearCredentials(): void {
  rmSync(credentialsPath(), { force: true });
}
