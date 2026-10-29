import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { DashboardInfo } from "@rev/shared";
import { api } from "../api";
import { useUser } from "../auth";
import { PageHeader } from "../components/Layout";
import { ReviewCard, TaskRow } from "../components/lists";
import { Card, ErrorBox, PageLoader } from "../components/ui";

function Section({ title, count, children, empty }: { title: string; count: number; children: React.ReactNode; empty: string }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700">
        {title} <span className="font-normal text-zinc-400">{count}</span>
      </h2>
      {count ? children : <p className="text-sm text-zinc-400">{empty}</p>}
    </section>
  );
}

export function Dashboard() {
  const user = useUser();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardInfo>("/api/dashboard"),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <PageHeader title={`Hi, ${user.name.split(" ")[0]}`} subtitle="What needs your attention." />
      <div className="mx-auto max-w-5xl space-y-8 px-8 py-6">
        <ErrorBox error={error} />
        {isLoading || !data ? (
          <PageLoader />
        ) : (
          <>
            <Section title="Reviews waiting for your decision" count={data.reviewsToDecide.length} empty="Nothing to review right now.">
              <div className="grid gap-3 lg:grid-cols-2">
                {data.reviewsToDecide.map((r) => (
                  <ReviewCard key={r.id} review={r} />
                ))}
              </div>
            </Section>
            <Section title="Your agents are working on" count={data.myAgentsTasks.length} empty="Your agents have no open tasks.">
              <Card className="divide-y divide-zinc-100">
                {data.myAgentsTasks.map((t) => (
                  <TaskRow key={t.id} task={t} showProject />
                ))}
              </Card>
            </Section>
            <Section title="Assigned to you" count={data.myTasks.length} empty="No open tasks assigned to you.">
              <Card className="divide-y divide-zinc-100">
                {data.myTasks.map((t) => (
                  <TaskRow key={t.id} task={t} showProject />
                ))}
              </Card>
            </Section>
            <Section title="Recent reviews" count={data.recentReviews.length} empty="No reviews yet.">
              <div className="grid gap-3 lg:grid-cols-2">
                {data.recentReviews.map((r) => (
                  <ReviewCard key={r.id} review={r} />
                ))}
              </div>
            </Section>
            {!data.recentReviews.length && !data.myTasks.length && (
              <Card className="p-5 text-sm text-zinc-600">
                New here? <Link to="/projects" className="text-accent-600 underline">Create a project</Link>, then{" "}
                <Link to="/agents" className="text-accent-600 underline">link an agent</Link> so it can submit review kits.
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
