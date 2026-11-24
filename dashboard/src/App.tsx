import { useEffect, useState } from "react";
import { get, getToken, post, setToken } from "./api";
import { ToastProvider } from "./components/ui";
import { AppProvider, useApp } from "./context";
import { Audit, Library, Links, Login, NotFound, Settings } from "./pages/Admin";
import { Ask } from "./pages/Ask";
import { JobView, Jobs } from "./pages/Jobs";
import { Platforms } from "./pages/Platforms";
import { PlanView, Plans } from "./pages/Plans";
import { Projects } from "./pages/Projects";
import { Setup } from "./pages/Setup";
import { RunView, Workflows } from "./pages/Workflows";
import { go, href, useRoute } from "./router";

const NAV: { id: string; label: string; phone?: boolean }[] = [
  { id: "platforms", label: "Platforms", phone: true },
  { id: "ask", label: "Ask", phone: true },
  { id: "workflows", label: "Workflows", phone: true },
  { id: "jobs", label: "Jobs", phone: true },
  { id: "plans", label: "Plans" },
  { id: "projects", label: "Projects" },
  { id: "links", label: "Links" },
  { id: "library", label: "Library" },
  { id: "audit", label: "Audit log" },
  { id: "settings", label: "Settings" },
  { id: "setup", label: "Setup" },
];

// Detail pages belong to a section for navigation highlighting.
const SECTION: Record<string, string> = { runs: "workflows" };

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    void (async () => {
      const code = /^#\/login\/(.+)$/.exec(window.location.hash)?.[1];
      if (code) {
        // Take the one-time code out of the address bar and history straight away.
        history.replaceState(null, "", "#/setup");
        await post<{ token: string }>("/login", { code }).then((r) => setToken(r.token), () => {});
      }
      if (!getToken()) return setAuthed(false);
      await get("/status").then(
        () => setAuthed(true),
        () => setAuthed(false),
      );
    })();
    const on = () => setAuthed(false);
    window.addEventListener("openhelper:unauthorized", on);
    return () => window.removeEventListener("openhelper:unauthorized", on);
  }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <ToastProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </ToastProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { self } = useApp();
  const section = SECTION[route[0]!] ?? route[0]!;
  const phoneMore = !NAV.some((n) => n.phone && n.id === section);
  useEffect(() => {
    if (window.location.hash) return;
    void get<{ done: boolean }>("/setup").then((s) => {
      if (!s.done) go("setup");
    });
  }, []);
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <Logo />
          OpenHelper
        </div>
        {NAV.map((n) => (
          <a key={n.id} href={href(n.id)} aria-current={section === n.id ? "page" : undefined}>
            {n.label}
          </a>
        ))}
        <div className="spacer" />
        <div className="who">Signed in to {self || "…"}</div>
      </nav>
      <main id="main">
        <Page route={route} />
      </main>
      <nav className="tabbar" aria-label="Main">
        {NAV.filter((n) => n.phone).map((n) => (
          <a key={n.id} href={href(n.id)} aria-current={section === n.id ? "page" : undefined}>
            {n.label}
          </a>
        ))}
        <a href={href("more")} aria-current={phoneMore ? "page" : undefined}>
          More
        </a>
      </nav>
    </div>
  );
}

function Page({ route }: { route: string[] }) {
  const [a, b] = route;
  switch (a) {
    case "setup":
      return <Setup />;
    case "platforms":
      return <Platforms />;
    case "ask":
      return <Ask />;
    case "workflows":
      return <Workflows />;
    case "runs":
      return b ? <RunView id={b} /> : <Workflows />;
    case "jobs":
      return b ? <JobView id={b} /> : <Jobs />;
    case "plans":
      return b ? <PlanView name={b} /> : <Plans />;
    case "projects":
      return <Projects />;
    case "links":
      return <Links />;
    case "library":
      return <Library />;
    case "audit":
      return <Audit />;
    case "settings":
      return <Settings {...(b ? { file: route.slice(1).join("/") } : {})} />;
    case "more":
      return <More />;
    default:
      return <NotFound />;
  }
}

function More() {
  return (
    <>
      <h1 style={{ marginBottom: 16 }}>More</h1>
      <ul className="list panel">
        {NAV.filter((n) => !n.phone).map((n) => (
          <li key={n.id}>
            <a className="item" href={href(n.id)}>
              <strong>{n.label}</strong>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

function Logo() {
  // Two machines: one running (filled), one linked (outlined).
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="9" cy="16" r="6" fill="var(--cobalt)" />
      <path d="M15 16 H17" stroke="var(--cobalt)" strokeWidth="2" />
      <circle cx="23" cy="16" r="6" fill="none" stroke="var(--cobalt)" strokeWidth="3" />
    </svg>
  );
}
