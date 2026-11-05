import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { encryptToken } from "@/lib/meta/oauth";
import { subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";
import { getMetaGraphApiVersion } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Connect an Instagram account with a dashboard-generated system-user token.
 *
 * New Meta apps can't run the Instagram-login OAuth redirect, so you generate a
 * never-expiring system-user token per account in the App Dashboard (Instagram
 * API use case -> step 2 "Generate access tokens") and POST it here with the
 * account id shown next to it. Everything runs server-side, so the token is
 * never exposed outside this request.
 *
 * It probes graph.facebook.com for the account first (so a bad token or a field
 * the account doesn't expose gives a clear answer instead of a silent fail),
 * subscribes the account to the comments + messages webhooks, and stores the
 * encrypted token with no expiry (system-user tokens don't expire).
 *
 * Body: { accessToken: string, instagramId: string, username?: string }
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  let body: { accessToken?: string; instagramId?: string; username?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const accessToken = body.accessToken?.trim();
  const instagramId = body.instagramId?.trim();
  if (!accessToken || !instagramId) {
    return NextResponse.json(
      { success: false, error: "accessToken and instagramId are required" },
      { status: 400 }
    );
  }

  const base = `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
  // Token goes in the Authorization header, never the URL, so it can't leak
  // into server logs.
  async function graphGet(path: string) {
    try {
      const res = await fetch(`${base}/${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { ok: res.ok, status: res.status, body: json };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Minimal vs richer fields: if min works but full fails, it's a field the
  // account doesn't expose; if min fails too, the token can't reach the account.
  const probeMin = await graphGet(`${instagramId}?fields=username`);
  const probeFull = await graphGet(
    `${instagramId}?fields=username,name,followers_count,profile_picture_url`
  );

  const minUsername =
    probeMin.ok &&
    probeMin.body &&
    typeof probeMin.body === "object" &&
    "username" in (probeMin.body as Record<string, unknown>)
      ? String((probeMin.body as Record<string, unknown>).username)
      : null;

  const canReachAccount = probeMin.ok || probeFull.ok;

  // Don't store an account the token can't even read — the DM send would fail
  // the same way. Hand back the probes so we can see exactly why.
  if (!canReachAccount) {
    return NextResponse.json(
      {
        success: false,
        stored: false,
        error: "Token cannot reach this Instagram account",
        probes: { min: probeMin, full: probeFull },
      },
      { status: 502 }
    );
  }

  let webhookSubscribed = false;
  let subscribeError: string | null = null;
  try {
    const subscription = await subscribeInstagramAccountToWebhooks(
      instagramId,
      accessToken
    );
    webhookSubscribed = Boolean(
      (subscription as { success?: boolean }).success
    );
  } catch (err) {
    subscribeError = err instanceof Error ? err.message : String(err);
    console.warn("[connect-manual] Webhook subscription failed:", err);
  }

  const username = minUsername ?? body.username?.trim() ?? instagramId;
  const data = {
    username,
    accessToken: encryptToken(accessToken),
    // System-user tokens never expire (confirmed in the token debugger), so the
    // refresh cron must leave this one alone.
    tokenExpiresAt: null,
    webhookSubscribed,
  };

  const existing = await prisma.instagramAccount.findUnique({
    where: { instagramId },
  });
  if (existing) {
    if (existing.workspaceId !== context.workspaceId) {
      return NextResponse.json(
        { success: false, error: "Account is connected to another workspace" },
        { status: 409 }
      );
    }
    await prisma.instagramAccount.update({ where: { id: existing.id }, data });
  } else {
    await prisma.instagramAccount.create({
      data: {
        ...data,
        workspaceId: context.workspaceId,
        instagramId,
        provider: "META",
      },
    });
  }

  return NextResponse.json({
    success: true,
    stored: true,
    data: { instagramId, username, webhookSubscribed },
    probes: { min: probeMin, full: probeFull },
    subscribeError,
  });
}
