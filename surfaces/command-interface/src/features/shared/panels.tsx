import { Fragment, type ReactNode } from "react";

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1 }}>{title}</span>
        {actions}
      </header>
      <div className="section__body">{children}</div>
    </section>
  );
}

export function FieldGrid({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="field-grid">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "N/A"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function InspectorHeading({ name, id }: { name: string; id: string }) {
  return (
    <div className="inspector__heading">
      <span className="inspector__name">{name}</span>
      <span className="inspector__id">{id}</span>
    </div>
  );
}
