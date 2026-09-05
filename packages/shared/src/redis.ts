// Plain options let each app use BullMQ's own Redis dependency.
export function bullConnectionFromUrl(value: string | undefined): { host: string; port: number; db: number; username?: string; password?: string; tls?: Record<string, never> } {
  if (!value) throw new Error("REDIS_URL is missing");
  const url = new URL(value);
  if (!["redis:", "rediss:"].includes(url.protocol)) {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  const database = url.pathname.slice(1);
  if (database && !/^\d+$/.test(database)) {
    throw new Error("REDIS_URL database must be a non-negative integer");
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 6379,
    db: database ? Number(database) : 0,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}