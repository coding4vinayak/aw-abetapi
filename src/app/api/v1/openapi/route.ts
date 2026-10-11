import { NextResponse } from "next/server";
import { openapiSpec } from "@/lib/openapi";

export const dynamic = "force-dynamic";

/** This document, unauthenticated: integrators evaluate before holding a key. */
export async function GET() {
  return NextResponse.json(openapiSpec);
}
