import { NextResponse } from "next/server";
import { prisma } from "@pkg/db";

export async function GET() {
  try {
    // Very cheap query: ensures DB connection works + schema exists
    await prisma.user.count(); // or prisma.activity.count(), etc.

    return NextResponse.json({
      ok: true,
      db: "ok",
      ts: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        db: "error",
        ts: new Date().toISOString(),
        message: err?.message ?? String(err),
        code: err?.code, // Prisma errors often include a code like P1000
      },
      { status: 500 }
    );
  }
}
