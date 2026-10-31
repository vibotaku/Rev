import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FolderKanban, LayoutDashboard, LogOut, Menu, Server, Settings, Shield, X } from "lucide-react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import type { ProjectInfo } from "@rev/shared";
import { api } from "../api";
import { useMe } from "../auth";
import { cx } from "../lib";
import { Avatar, PageLoader } from "./ui";

function NavItem({ to, icon, children, end }: { to: string; icon: React.ReactNode; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
          isActive ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100",
        )
      }
    >
      {icon}
      <span className="truncate">{children}</span>
    </NavLink>
  );
}

export function Layout() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectInfo[]>("/api/projects"),
    enabled: !!me.data,
  });
  // On small screens the sidebar is a drawer. It belongs to the page it was opened on,
  // so following a link (or going back) closes it.
  const [menuOn, setMenuOn] = useState<string | null>(null);
  const menuOpen = menuOn === location.pathname;
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOn(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (me.isLoading) return <PageLoader />;
  if (!me.data) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} replace />;
  }
  const user = me.data.user;

  async function logout() {
    await api.post("/api/auth/logout");
    qc.clear();
    navigate("/login");
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <header className="flex h-12 shrink-0 items-center gap-2 bg-zinc-900 px-2 md:hidden">
        <button
          className="rounded-md p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white"
          onClick={() => setMenuOn(location.pathname)}
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </button>
        <img src="/favicon.svg" alt="" className="size-6" />
        <span className="text-lg font-semibold tracking-tight text-white">Rev</span>
      </header>
      {menuOpen && <div className="fixed inset-0 z-40 bg-zinc-900/50 md:hidden" onClick={() => setMenuOn(null)} />}
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] shrink-0 flex-col bg-zinc-900 px-3 py-4 transition-[translate,visibility] md:static md:z-auto md:w-56 md:translate-x-0 md:transition-none",
          menuOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full max-md:invisible",
        )}
      >
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="text-lg font-semibold tracking-tight text-white">Rev</span>
          <button
            className="-mr-1 ml-auto rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white md:hidden"
            onClick={() => setMenuOn(null)}
            aria-label="Close menu"
          >
            <X className="size-5" />
          </button>
        </div>
        <nav className="space-y-0.5">
          <NavItem to="/" end icon={<LayoutDashboard className="size-4" />}>
            Dashboard
          </NavItem>
          <NavItem to="/projects" end icon={<FolderKanban className="size-4" />}>
            Projects
          </NavItem>
          <NavItem to="/agents" icon={<Bot className="size-4" />}>
            My agents
          </NavItem>
          <NavItem to="/nodes" icon={<Server className="size-4" />}>
            Nodes
          </NavItem>
          {user.role === "admin" && (
            <NavItem to="/admin" icon={<Shield className="size-4" />}>
              Admin
            </NavItem>
          )}
        </nav>
        <div className="mt-6 mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Projects</div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {projects.data
            ?.filter((p) => !p.archived)
            .map((p) => (
              <NavItem
                key={p.id}
                to={`/p/${p.key}`}
                icon={<span className="w-8 shrink-0 text-[10px] font-semibold text-zinc-500">{p.key}</span>}
              >
                {p.name}
              </NavItem>
            ))}
        </nav>
        <div className="mt-3 flex items-center gap-2 border-t border-zinc-800 px-1 pt-3">
          <Avatar user={user} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-zinc-100">{user.name}</div>
            <div className="truncate text-xs text-zinc-500">{user.email}</div>
          </div>
          <NavLink to="/account" className="rounded p-1 text-zinc-500 hover:text-zinc-200" title="Account">
            <Settings className="size-4" />
          </NavLink>
          <button onClick={logout} className="rounded p-1 text-zinc-500 hover:text-zinc-200" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-zinc-200 bg-white px-4 py-4 md:px-8 md:py-5 lg:flex-nowrap">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-zinc-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">{actions}</div>}
    </div>
  );
}
