export default async function HealthPage() {
  const res = await fetch("http://localhost:3000/api/health", {
    cache: "no-store",
  });
  const data = await res.json();
  console.log("DATABASE_URL present?", Boolean(process.env.DATABASE_URL));
  return (
    <pre style={{ padding: 16 }}>
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
