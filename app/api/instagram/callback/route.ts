import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl, getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import {
  debugToken,
  getGrantedInstagramAccounts,
  getLongLivedToken,
  getUserInfo,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import {
  encryptToken,
  exchangeCodeForToken,
  verifyOAuthState,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

export const runtime = "nodejs";

/**
 * Unified-login OAuth callback.
 *
 * The person authorized their Instagram professional account(s) through the
 * Facebook dialog. We exchange the code for a user token, make it long-lived,
 * find which Instagram accounts it was granted for, and store one connection
 * per account (subscribing each to the comments + messages webhooks).
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=denied`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/instagram/callback`;
    const { accessToken: shortLivedToken } = await exchangeCodeForToken(
      code,
      redirectUri
    );
    const { accessToken: longLivedToken, expiresIn } = await getLongLivedToken(
      shortLivedToken
    );

    const igIds = await getGrantedInstagramAccounts(longLivedToken);
    if (igIds.length === 0) {
      // The token works but we couldn't read which Instagram account it
      // unlocked. Capture what the token actually exposes so we can see where
      // the id lives (none of these responses contain the token itself).
      const diagnostic = await collectAccountDiscoveryDiagnostic(longLivedToken);
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "ERROR",
            workspaceId: state.workspaceId,
            message:
              "Instagram connect: the authorization granted no Instagram account",
            payload: JSON.parse(JSON.stringify(diagnostic)),
          },
        })
        .catch(() => {});
      return NextResponse.redirect(`${baseUrl}/settings?instagram=no_account`);
    }

    const encryptedToken = encryptToken(longLivedToken);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    let connected = 0;
    for (const instagramId of igIds) {
      let username = instagramId;
      let name: string | null = null;
      try {
        const info = await getUserInfo(longLivedToken, instagramId);
        username = info.username ?? instagramId;
        name = info.name ?? null;
      } catch (infoError) {
        console.warn("[Instagram Callback] getUserInfo failed:", infoError);
      }

      let webhookSubscribed = false;
      try {
        const subscription = await subscribeInstagramAccountToWebhooks(
          instagramId,
          longLivedToken
        );
        webhookSubscribed = Boolean(
          (subscription as { success?: boolean }).success
        );
      } catch (subscriptionError) {
        console.warn(
          "[Instagram Callback] Webhook subscription failed:",
          subscriptionError
        );
      }

      const data = {
        username,
        name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        webhookSubscribed,
      };
      const existing = await prisma.instagramAccount.findUnique({
        where: { instagramId },
      });
      if (existing) {
        if (existing.workspaceId !== state.workspaceId) continue;
        await prisma.instagramAccount.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await prisma.instagramAccount.create({
          data: {
            ...data,
            workspaceId: state.workspaceId,
            instagramId,
            provider: "META",
          },
        });
      }
      connected++;
    }

    return NextResponse.redirect(
      `${baseUrl}/settings?instagram=connected&count=${connected}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Callback] Error:", err);
    // The message is the only diagnostic a self-hoster gets for a failed
    // connect, so persist it rather than leaving it in logs they can't reach.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Instagram connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});
    return NextResponse.redirect(`${baseUrl}/settings?instagram=error`);
  }
}

// Temporary: dump the places an Instagram account id might live for a unified
// login token, so the discovery step can be pointed at the right one.
async function collectAccountDiscoveryDiagnostic(
  userToken: string
): Promise<Record<string, unknown>> {
  const base = `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
  async function get(path: string) {
    try {
      const res = await fetch(`${base}/${path}`, {
        headers: { Authorization: `Bearer ${userToken}` },
        cache: "no-store",
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text.slice(0, 500);
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const out: Record<string, unknown> = {};
  try {
    const appToken = `${requireEnv("FACEBOOK_APP_ID")}|${requireEnv(
      "FACEBOOK_APP_SECRET"
    )}`;
    out.debug_token = await debugToken(userToken, appToken);
  } catch (e) {
    out.debug_token = { error: e instanceof Error ? e.message : String(e) };
  }
  out.me = await get("me?fields=id,name");
  out.me_accounts = await get(
    "me/accounts?fields=name,instagram_business_account{id,username}"
  );
  out.me_businesses = await get("me/businesses?fields=id,name");
  return out;
}
