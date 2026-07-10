import { Component, ComponentChildren } from 'preact';

// Without this, any thrown error unmounts the whole Preact tree and the TV just
// shows a black screen with no clue what happened (webOS has no visible console).
// This catches three failure modes and renders the message on-screen instead:
//   - render / lifecycle throws  -> componentDidCatch (fatal: the tree is gone,
//     so the only recovery is a reload)
//   - uncaught script errors     -> window 'error'
//   - unhandled promise rejections (e.g. a failed fetch/parse in a .then) ->
//     'unhandledrejection'
// The last two are shown as dismissible so a transient error doesn't brick the app.

// Lets non-fatal, already-caught errors (e.g. a swallowed .catch on a background
// fetch) still surface in the overlay for diagnosis, without crashing the tree.
let reporter: ((err: unknown) => void) | null = null;
export function reportError(err: unknown): void {
  if (reporter) reporter(err);
  else console.error('[immich-webos] reportError (no boundary mounted):', err);
}

interface Props {
  children: ComponentChildren;
}
interface State {
  error: string | null;
  stack: string | null;
  fatal: boolean;
}

function messageOf(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function stackOf(err: unknown): string | null {
  return err instanceof Error && err.stack ? err.stack : null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null, fatal: false };

  static getDerivedStateFromError(err: unknown): Partial<State> {
    return { error: messageOf(err), stack: stackOf(err), fatal: true };
  }

  componentDidCatch(err: unknown) {
    // Also log so it shows up if a remote inspector *is* attached.
    console.error('[immich-webos] render error:', err);
  }

  componentDidMount() {
    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onRejection);
    reporter = (err) => {
      if (this.state.fatal) return;
      console.error('[immich-webos] reported error:', err);
      this.setState({ error: messageOf(err), stack: stackOf(err), fatal: false });
    };
  }

  componentWillUnmount() {
    window.removeEventListener('error', this.onError);
    window.removeEventListener('unhandledrejection', this.onRejection);
    reporter = null;
  }

  private onError = (e: ErrorEvent) => {
    // Ignore resource load errors (e.g. an <img> 404) — those aren't crashes and
    // fire with the element as target, not window.
    if (e.target && e.target !== window) return;
    if (this.state.fatal) return; // don't overwrite a fatal render error
    console.error('[immich-webos] uncaught error:', e.error ?? e.message);
    this.setState({ error: messageOf(e.error ?? e.message), stack: stackOf(e.error), fatal: false });
  };

  private onRejection = (e: PromiseRejectionEvent) => {
    if (this.state.fatal) return;
    console.error('[immich-webos] unhandled rejection:', e.reason);
    this.setState({ error: messageOf(e.reason), stack: stackOf(e.reason), fatal: false });
  };

  private dismiss = () => this.setState({ error: null, stack: null, fatal: false });
  private reload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div class="errbox" role="alert">
        <div class="errbox-inner">
          <h1 class="errbox-title">Something went wrong</h1>
          <p class="errbox-msg">{this.state.error}</p>
          {this.state.stack && <pre class="errbox-stack">{this.state.stack}</pre>}
          <div class="errbox-actions">
            <button class="errbox-btn focusable" onClick={this.reload}>
              Reload app
            </button>
            {!this.state.fatal && (
              <button class="errbox-btn focusable" onClick={this.dismiss}>
                Dismiss
              </button>
            )}
          </div>
          <p class="errbox-hint">
            If you're reporting this, a photo of this screen helps a lot.
          </p>
        </div>
      </div>
    );
  }
}
