import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FolderKanban, LayoutDashboard, LogOut, Settings, Shield } from "lucide-react";
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
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col bg-zinc-900 px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="text-lg font-semibold tracking-tight text-white">Rev</span>
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
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-zinc-200 bg-white px-8 py-5">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-zinc-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
