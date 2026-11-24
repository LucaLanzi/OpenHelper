import { useEffect, useState } from "react";
import { get, post, put } from "../api";
import { Empty, ErrorNote, Markdown, PageHead, State, useLoad, useToast } from "../components/ui";
import { href } from "../router";

interface PlanItem {
  name: string;
  status: string;
  title: string;
}

export function Plans() {
  const plans = useLoad(() => get<PlanItem[]>("/plans"));
  return (
    <>
      <PageHead title="Plans" intro="Every plan the planner wrote, saved as Markdown. Edit one, then approve it to hand it to the coder." />
      <ErrorNote error={plans.error} />
      {plans.data?.length ? (
        <ul className="list panel">
          {plans.data.map((p) => (
            <li key={p.name}>
              <a className="item" href={href("plans", p.name)}>
                <div className="row between">
                  <strong>{p.title || p.name}</strong>
                  <State s={p.status === "approved" ? "done" : "created"} />
                </div>
                <span className="small muted">{p.name}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No plans yet">Start the plan-only or implement-feature workflow, or a "Draft a plan" job.</Empty>
      )}
    </>
  );
}

export function PlanView({ name }: { name: string }) {
  const toast = useToast();
  const plan = useLoad(() => get<{ content: string }>(`/plans/${name}`), [name]);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  useEffect(() => setText(plan.data?.content ?? ""), [plan.data]);

  const dirty = text !== (plan.data?.content ?? "");
  const approved = /status:\s*approved/.test(plan.data?.content ?? "");

  const save = async () => {
    await put(`/plans/${name}`, { content: text });
    toast("Plan saved");
    plan.reload();
  };
  const approve = async () => {
    if (dirty) await put(`/plans/${name}`, { content: text });
    await post(`/plans/${name}/approve`);
    toast("Plan approved");
    plan.reload();
  };

  return (
    <>
      <PageHead title={/^#\s+(.+)$/m.exec(text)?.[1] ?? name} intro={name}>
        <State s={approved ? "done" : "created"} />
      </PageHead>
      <ErrorNote error={plan.error} />
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="quiet" onClick={() => setPreview(!preview)} aria-pressed={preview}>
          {preview ? "Edit" : "Preview"}
        </button>
      </div>
      {preview ? (
        <div className="panel">
          <Markdown text={text.replace(/^---[\s\S]*?---\n/, "")} />
        </div>
      ) : (
        <textarea className="code" value={text} onChange={(e) => setText(e.target.value)} aria-label="Plan text" style={{ minHeight: 480 }} />
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => void save()} disabled={!dirty}>
          Save plan
        </button>
        <button className="primary" onClick={() => void approve()} disabled={approved && !dirty}>
          {dirty ? "Save and approve" : "Approve plan"}
        </button>
      </div>
    </>
  );
}
