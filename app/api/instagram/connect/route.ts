import { NextRequest, NextResponse } from "next/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { getBaseUrl, getMissingInstagramOAuthEnv } from "@/lib/env";
import { createOAuthState, getAuthorizationUrl } from "@/lib/meta/oauth";

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?instagram=forbidden`);
  }

  // getAuthorizationUrl and createOAuthState call requireEnv, which throws.
  // Without this check an incomplete .env surfaces as a 500 on a plain <a>
  // navigation, which reads to the user as the button doing nothing at all.
  const missingEnv = getMissingInstagramOAuthEnv();
  if (missingEnv.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?instagram=misconfigured&missing=${encodeURIComponent(
        missingEnv.join(",")
      )}`
    );
  }

  // The unified-login dialog hands back a system-user token that can't list the
  // Instagram accounts it was granted. When we already know the id (a business
  // asset shown in the dashboard/dialog), pass it as ?account=<ig id> and the
  // callback connects it directly.
  const accountParam = request.nextUrl.searchParams.get("account");
  // Only an all-digits Instagram account id; the callback still verifies the
  // token can actually read it before connecting.
  const account =
    accountParam && /^\d+$/.test(accountParam) ? accountParam : undefined;
  const redirectUri = `${getBaseUrl()}/api/instagram/callback`;
  const state = createOAuthState(context.workspaceId, account);

  return NextResponse.redirect(getAuthorizationUrl(redirectUri, state));
}
