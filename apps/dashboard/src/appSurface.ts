export type AppSurface = "console" | "app";

const rawSurface = (import.meta.env.VITE_APP_SURFACE as string | undefined)?.trim().toLowerCase();
const appHostname = (import.meta.env.VITE_APP_HOSTNAME as string | undefined)?.trim().toLowerCase() || "app.memorynode.ai";

export function getAppSurface(): AppSurface {
  const hostname = window.location.hostname.trim().toLowerCase();
  const pathname = normalizePathname(window.location.pathname);
  if (hostname === appHostname) return "app";
  if (isFounderPath(pathname)) return "app";
  return rawSurface === "app" ? "app" : "console";
}

export function normalizePathname(pathname: string): string {
  if (!pathname.trim()) return "/";
  const normalized = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  return normalized || "/";
}

export function isFounderPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/founder" || normalized.startsWith("/founder/");
}
