// Per-user letter avatar: first letter of the name (falling back to email) on
// a colour picked from the user id, so a person keeps the same colour in the
// sidebar and on the launch account picker.

const AVATAR_COLORS = ['#4250af', '#b3261e', '#2e7d32', '#8e24aa', '#ef6c00', '#00838f'];

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initialOf(name?: string, email?: string): string {
  return (name || email || '?').trim().charAt(0).toUpperCase() || '?';
}

export function UserInitial({ id, name, email }: { id: string; name?: string; email?: string }) {
  return (
    <span class="user-initial" style={{ background: colorFor(id) }} aria-hidden="true">
      {initialOf(name, email)}
    </span>
  );
}
