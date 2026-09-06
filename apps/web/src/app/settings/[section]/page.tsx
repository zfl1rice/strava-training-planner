import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getPlanningSettings } from "@pkg/db";
import { SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";
import SettingsEditor from "../settings-editor";

export const dynamic = "force-dynamic";
const titles = { profile: "Athlete profile", goals: "Race goals", availability: "Training availability" };

export default async function SettingsPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section !== "profile" && section !== "goals" && section !== "availability") notFound();
  let settings = null;
  let loadError = false;
  try {
    const user = await userFromSession((await cookies()).get(SESSION_COOKIE)?.value);
    if (user) settings = await getPlanningSettings(user.id);
  } catch { loadError = true; }
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8">
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Your training</p>
      <h1 className="text-2xl font-semibold">{titles[section]}</h1>
      <p className="text-sm text-slate-600">Set the inputs for your future training plans.</p>
    </header>
    {loadError ? <p role="alert">Could not load your settings. Reload this page to try again.</p>
      : settings ? <SettingsEditor section={section} initialSettings={settings} />
      : <div className="settings-card space-y-3"><p>Connect Strava to save your personal training settings.</p><Link href="/" className="text-blue-700 underline">Go to Strava connection</Link></div>}
  </main>;
}
