import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";

// The Instagram-login OAuth callback is retired. New Meta apps must use unified
// login (Facebook Login for Business), whose system-user tokens are generated
// per account in the Meta App Dashboard and added through
// POST /api/instagram/connect-manual. This handler is kept only so an old
// bookmarked OAuth redirect lands softly on settings instead of 404ing.
export async function GET() {
  return NextResponse.redirect(`${getBaseUrl()}/settings?instagram=manual`);
}
