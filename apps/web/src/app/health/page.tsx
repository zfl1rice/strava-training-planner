import { checkPostgresHealth, checkRedisHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const [postgres, redis] = await Promise.all([checkPostgresHealth(), checkRedisHealth()]);
  return (
    <pre style={{ padding: 16 }}>
      {JSON.stringify({ ok: postgres.ok && redis.ok, postgres, redis }, null, 2)}
    </pre>
  );
}
