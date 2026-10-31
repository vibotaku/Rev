import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Account } from "./pages/Account";
import { AdminLayout, AdminPeople } from "./pages/Admin";
import { AdminActiveDirectory } from "./pages/AdminActiveDirectory";
import { Agents } from "./pages/Agents";
import { ConnectAgent } from "./pages/ConnectAgent";
import { Dashboard } from "./pages/Dashboard";
import { Invite, Login, Setup } from "./pages/Auth";
import { ProjectLayout, ProjectMembers, ProjectSettings } from "./pages/Project";
import { ProjectReviews } from "./pages/ProjectReviews";
import { ProjectTasks } from "./pages/ProjectTasks";
import { Projects } from "./pages/Projects";
import { ReviewPage } from "./review/ReviewPage";
import { TaskPage } from "./pages/TaskPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createBrowserRouter([
  { path: "/setup", element: <Setup /> },
  { path: "/login", element: <Login /> },
  { path: "/invite/:token", element: <Invite /> },
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "projects", element: <Projects /> },
      { path: "agents", element: <Agents /> },
      { path: "agents/connect", element: <ConnectAgent /> },
      {
        path: "admin",
        element: <AdminLayout />,
        children: [
          { index: true, element: <AdminPeople /> },
          { path: "active-directory", element: <AdminActiveDirectory /> },
        ],
      },
      { path: "account", element: <Account /> },
      { path: "p/:key/tasks/:number", element: <TaskPage /> },
      { path: "p/:key/reviews/:number", element: <ReviewPage /> },
      {
        path: "p/:key",
        element: <ProjectLayout />,
        children: [
          { index: true, element: <Navigate to="tasks" replace /> },
          { path: "tasks", element: <ProjectTasks /> },
          { path: "reviews", element: <ProjectReviews /> },
          { path: "members", element: <ProjectMembers /> },
          { path: "settings", element: <ProjectSettings /> },
        ],
      },
      { path: "*", element: <div className="p-8 text-sm text-zinc-500">Page not found.</div> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
