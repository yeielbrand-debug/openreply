import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";

// Instagram-login OAuth is not available to new Meta apps (they can only use
// unified login / Facebook Login for Business). Accounts are now connected with
// a unified-login system-user token via POST /api/instagram/connect-manual, so
// this route just points there instead of starting an OAuth round trip that
// would fail.
export async function GET() {
  return NextResponse.redirect(`${getBaseUrl()}/settings?instagram=manual`);
}
