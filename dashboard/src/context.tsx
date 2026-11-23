import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { get, type Project } from "./api";

interface AppState {
  self: string;
  roles: string[];
  projects: Project[];
  project: string;
  setProject: (p: string) => void;
  reloadProjects: () => void;
}

const Ctx = createContext<AppState>({ self: "", roles: [], projects: [], project: "", setProject: () => {}, reloadProjects: () => {} });

const KEY = "openhelper.project";

export function AppProvider({ children }: { children: ReactNode }) {
  const [self, setSelf] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProjectState] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void get<{ platform: string; roles: string[] }>("/health").then((h) => {
      setSelf(h.platform);
      setRoles(h.roles);
    });
  }, []);
  useEffect(() => {
    void get<Project[]>("/projects")
      .then((ps) => {
        setProjects(ps);
        if (ps.length && !ps.some((p) => p.name === project)) setProjectState(ps[0]!.name);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const setProject = (p: string) => {
    setProjectState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      // ignore
    }
  };

  return (
    <Ctx.Provider value={{ self, roles, projects, project, setProject, reloadProjects: () => setTick((t) => t + 1) }}>
      {children}
    </Ctx.Provider>
  );
}

export const useApp = () => useContext(Ctx);

/** The project switcher used across pages. */
export function ProjectPicker() {
  const { projects, project, setProject } = useApp();
  if (!projects.length) return null;
  return (
    <label className="field" style={{ minWidth: 200 }}>
      <span className="hint">Project</span>
      <select value={project} onChange={(e) => setProject(e.target.value)}>
        {projects.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
