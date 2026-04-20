import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return <div className="shell">{children}</div>;
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">{title}</div>
      <div className="panel-body">{children}</div>
    </section>
  );
}
