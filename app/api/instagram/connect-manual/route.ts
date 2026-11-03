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

/**
 * Connect an Instagram account using a unified-login system-user token (SUAT).
 *
 * New Meta apps can only use unified login (Facebook Login for Business), which
 * has no Instagram-login OAuth. For your own accounts you generate a never-
 * expiring system-user token per account in the Meta App Dashboard
 * (Use case → Generate access tokens → Add account) and POST it here with the
 * Instagram account id. We fetch the profile, subscribe the account to the
 * comments + messages webhooks, and store the (encrypted) token.
 *
 * Body: { instagramId: string, accessToken: string }
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

  let body: { instagramId?: string; accessToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const instagramId = body.instagramId?.trim();
  const accessToken = body.accessToken?.trim();
  if (!instagramId || !accessToken) {
    return NextResponse.json(
      { success: false, error: "instagramId and accessToken are required" },
      { status: 400 }
    );
  }

  try {
    // Validates the token + id against Graph, and gives us the handle/name to
    // display. Throws (and we surface the Meta error) if either is wrong.
    const info = await getUserInfo(accessToken, instagramId);

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
      // Unified-login system-user tokens do not expire, so there is nothing for
      // the refresh cron to do (it only picks up rows with a non-null expiry).
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
      data: { instagramId, username: info.username, name: info.name, webhookSubscribed },
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
