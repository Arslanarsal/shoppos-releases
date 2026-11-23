export const DEVELOPER = { name: "M. Arslan", phone: "+923423407767", email: "arslanarsal455@gmail.com" };

export function DeveloperCard(props: { compact?: boolean }) {
  if (props.compact) {
    return (
      <div className="dev-credit" data-testid="dev-credit">
        <span>Built by {DEVELOPER.name}</span>
        <span>{DEVELOPER.phone}</span>
      </div>
    );
  }
  return (
    <div className="dev-card" data-testid="dev-card">
      <strong>Need help? Contact your developer</strong>
      <span>{DEVELOPER.name}</span>
      <span>
        Phone / WhatsApp: <a href={`tel:${DEVELOPER.phone}`}>{DEVELOPER.phone}</a>
      </span>
      <span>
        Email: <a href={`mailto:${DEVELOPER.email}`}>{DEVELOPER.email}</a>
      </span>
    </div>
  );
}
