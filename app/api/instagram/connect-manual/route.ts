import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { encryptToken } from "@/lib/meta/oauth";
import {
  getUserInfo,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";

export const runtime = "nodejs";

// A long-lived Instagram user token is valid ~60 days; the refresh cron
// (ig_refresh_token) extends it, so store a real expiry rather than null.
const LONG_LIVED_TOKEN_SECONDS = 5184000;

/**
 * Connect an Instagram account with a token generated in the Meta App Dashboard.
 *
 * New Meta apps can no longer run the Instagram-login OAuth redirect, so instead
 * of the connect/callback round trip you generate a long-lived token per account
 * in the dashboard (Instagram API use case -> step 2 "Generate access tokens" ->
 * "Add account"/"Generate token") and POST it here. The token is an Instagram
 * user token, so everything after this works exactly like the OAuth path did:
 * we read the profile from graph.instagram.com/me, subscribe the account to the
 * comments + messages webhooks, and store the encrypted token with its expiry.
 *
 * Body: { accessToken: string }  (instagramId is derived from the token)
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

  let body: { accessToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const accessToken = body.accessToken?.trim();
  if (!accessToken) {
    return NextResponse.json(
      { success: false, error: "accessToken is required" },
      { status: 400 }
    );
  }

  try {
    // Validates the token and resolves the account (and username) in one call.
    // Throws (and we surface the Meta error) if the token is wrong.
    const info = await getUserInfo(accessToken);
    const instagramId = String(info.user_id ?? info.id ?? "");
    if (!instagramId) {
      return NextResponse.json(
        { success: false, error: "Could not resolve Instagram account id from token" },
        { status: 502 }
      );
    }

    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        accessToken
      );
      webhookSubscribed = Boolean(
        (subscription as { success?: boolean }).success
      );
    } catch (subscriptionError) {
      console.warn(
        "[connect-manual] Webhook subscription failed:",
        subscriptionError
      );
    }

    const data = {
      username: info.username,
      name: info.name ?? null,
      accessToken: encryptToken(accessToken),
      tokenExpiresAt: new Date(Date.now() + LONG_LIVED_TOKEN_SECONDS * 1000),
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
      data: {
        instagramId,
        username: info.username,
        name: info.name,
        webhookSubscribed,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[connect-manual] Error:", err);
    return NextResponse.json(
      { success: false, error: message.slice(0, 300) },
      { status: 502 }
    );
  }
}
