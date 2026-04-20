export function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p className="muted small">{subtitle}</p>
    </div>
  );
}
