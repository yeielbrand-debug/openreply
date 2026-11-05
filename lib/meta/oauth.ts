import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { getEncryptionKeyHex, getMetaGraphApiVersion, requireEnv } from "@/lib/env";

// Unified login (Facebook Login for Business). New Meta apps can't use the
// retired Instagram-login OAuth, so the person authorizes their Instagram
// professional account through the Facebook dialog using the app's login
// configuration. The resulting user token reaches that account on
// graph.facebook.com — no Facebook Page required. The authorize hop has no API
// version; the code-for-token exchange is a versioned graph.facebook.com call.
const FACEBOOK_OAUTH_DIALOG = "https://www.facebook.com/dialog/oauth";

function facebookTokenUrl(): string {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}/oauth/access_token`;
}

// The login configuration that carries the Instagram permissions. Defaults to
// this app's config; override with META_LOGIN_CONFIG_ID for a different app.
function loginConfigId(): string {
  return process.env.META_LOGIN_CONFIG_ID ?? "2077800546956155";
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  workspaceId: string;
  ts: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function createOAuthState(workspaceId: string): string {
  const payload = base64UrlEncode(
    JSON.stringify({ workspaceId, ts: Date.now() } satisfies OAuthStatePayload)
  );
  return `${payload}.${signState(payload)}`;
}

export function verifyOAuthState(state: string | null): OAuthStatePayload | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = signState(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as OAuthStatePayload;
    if (typeof parsed.workspaceId !== "string" || !parsed.workspaceId) {
      return null;
    }

    // Reject a missing or non-numeric timestamp. `Date.now() - "abc"` is NaN,
    // and every comparison against NaN is false, so a non-numeric ts would
    // otherwise pass the age check and never expire. A ts in the future is
    // rejected for the same reason: it has not aged at all.
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }

    const age = Date.now() - parsed.ts;
    if (age < 0 || age > STATE_MAX_AGE_MS) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function getAuthorizationUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("FACEBOOK_APP_ID"),
    config_id: loginConfigId(),
    redirect_uri: redirectUri,
    response_type: "code",
    // Config-based logins default to a token response; force a code so the
    // callback runs the server-side exchange.
    override_default_response_type: "true",
    state,
  });

  return `${FACEBOOK_OAUTH_DIALOG}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string }> {
  const url = new URL(facebookTokenUrl());
  url.searchParams.set("client_id", requireEnv("FACEBOOK_APP_ID"));
  url.searchParams.set("client_secret", requireEnv("FACEBOOK_APP_SECRET"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    let detail: string;
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = await response.text();
    }
    throw new Error(`Token exchange failed: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  return { accessToken: data.access_token };
}

function getEncryptionKey(): Buffer {
  return Buffer.from(getEncryptionKeyHex(), "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);

  return combined.toString("base64");
}

export function decryptToken(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, "base64");

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}
