import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import {
  getTimelineBuckets,
  getBucket,
  getFavoriteBuckets,
  getFavoriteBucket,
  getAlbumBuckets,
  getAlbumBucket,
  logout,
  Album,
} from '../api/client';
import { clearSession, getUser } from '../auth/store';
import { getSort, setSort, SortSection, SortDir } from '../settings';
import { Asset } from '../api/assets';
import { PhotoGrid } from '../components/PhotoGrid';
import { Icon } from '../components/Icon';
import { Sidebar, Route } from '../components/Sidebar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Albums, AlbumsRestore } from './Albums';
import { Search } from './Search';
import { Fullscreen } from './Fullscreen';
import { useRemote } from '../nav/useRemote';
import { setRoot, focusables, focus, elementInViewport, focusVisibleContent } from '../nav/focus';
import { exitApp } from '../nav/exit';

interface Viewer {
  assets: Asset[];
  index: number;
}

// Main shell: Immich-style auto-hiding left sidebar + content area + fullscreen
// viewer overlay. Sidebar is collapsed (icon strip) by default; a left-edge
// d-pad press opens and focuses it, a right-edge press from it collapses and
// returns focus to the content. Back closes viewer, then open album, then
// collapses the sidebar.
export function Home({ onLogout }: { onLogout: () => void }) {
  const [route, setRoute] = useState<Route>('timeline');
  const [album, setAlbum] = useState<Album | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // The content focusable (thumbnail) that had focus when the sidebar was
  // opened, so collapsing the sidebar restores it instead of jumping to the top
  // of the grid. The grid never unmounts on a sidebar toggle, so its scroll
  // position is already intact — only focus needs returning.
  const lastContentFocus = useRef<HTMLElement | null>(null);
  const loadNextRef = useRef<(() => void) | null>(null);
  // Albums-list scroll + focus to restore when returning from an opened album.
  const albumsRestore = useRef<AlbumsRestore | null>(null);
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const user = getUser();

  // Per-section sort direction, seeded from the persisted preference. Held in
  // state so flipping it re-renders: the view wrapper's key includes the active
  // section's direction (below), so a flip remounts the grid and it refetches
  // in the new order. Search has no sortable order.
  const [sort, setSortState] = useState<Record<SortSection, SortDir>>({
    timeline: getSort('timeline'),
    favorites: getSort('favorites'),
    albums: getSort('albums'),
    album: getSort('album'),
  });
  // The section the visible view maps to (null while on Search — no sort there).
  const section: SortSection | null = album
    ? 'album'
    : route === 'timeline' || route === 'favorites' || route === 'albums'
      ? route
      : null;
  // Hide the sort button while scrolling down, reveal it on scroll up — keeps it
  // out of the way mid-browse but a flick up brings it back. Scroll events don't
  // bubble, so listen in the capture phase on the shell and read the scrolling
  // element's own scrollTop (works for whichever view's scroller fires).
  const [sortHidden, setSortHidden] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let lastY = 0;
    let lastTarget: EventTarget | null = null;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement;
      if (!t || typeof t.scrollTop !== 'number') return;
      const y = t.scrollTop;
      if (t !== lastTarget) {
        lastTarget = t;
        lastY = y;
        return;
      }
      const dy = y - lastY;
      if (Math.abs(dy) < 8) return; // ignore jitter
      setSortHidden(dy > 0 && y > 40);
      lastY = y;
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, []);

  const toggleSort = () => {
    if (!section) return;
    const next: SortDir = sort[section] === 'desc' ? 'asc' : 'desc';
    setSort(section, next);
    setSortState((s) => ({ ...s, [section]: next }));
    // The key flip remounts the grid; focus its first thumbnail once it mounts
    // (focusFirstContent retries while the first bucket loads) rather than
    // stranding focus on the now-detached sort button.
    setTimeout(() => focusFirstContent(), 0);
  };

  // open the sidebar and focus its currently-active tab
  const openSidebarFocusActive = () => {
    // remember where focus was in the content so we can return to it on collapse
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.hasAttribute('data-focusable') && !ae.hasAttribute('data-sidebar')) {
      lastContentFocus.current = ae;
    }
    setSidebarOpen(true);
    setTimeout(() => {
      const items = focusables().filter((e) => e.hasAttribute('data-sidebar'));
      const active = items.find((e) => e.classList.contains('active'));
      (active || items[0])?.focus();
    }, 0);
  };

  // collapse the sidebar and return focus to the thumbnail that was focused
  // before it opened (falling back to the first content item if that element is
  // gone, e.g. its bucket was evicted). focus() re-rings + eases the cell into
  // view; since the grid never scrolled while the sidebar was open, it's already
  // in place, so nothing actually moves.
  const collapseSidebar = () => {
    setSidebarOpen(false);
    setTimeout(() => {
      const el = lastContentFocus.current;
      // If the remembered thumb is still on screen, restore it. If the user
      // scrolled it out of view before opening the sidebar, don't yank the grid
      // back to it — focus a thumb in the current viewport instead.
      if (el && el.isConnected && el.offsetParent !== null && elementInViewport(el)) focus(el, true);
      else if (!focusVisibleContent()) focusFirstContent();
    }, 0);
  };

  // Re-scope nav root + focus the content area when the VIEW changes (tab or
  // album). Deliberately NOT keyed on `viewer`: the viewer is an overlay that
  // leaves the grid mounted, so toggling it must not reset grid focus/scroll —
  // closing restores focus to the viewed thumbnail explicitly (closeViewer).
  useEffect(() => {
    setRoot(rootRef.current);
    setSortHidden(false); // switching view resets to top → show the button
    // Returning to the albums list restores its own scroll + focus (see Albums);
    // don't yank focus to the first card in that case.
    if (!album && route === 'albums' && albumsRestore.current) return;
    setTimeout(() => focusFirstContent(), 0);
  }, [route, album]);

  const openViewer = useCallback((assets: Asset[], index: number) => {
    setViewer({ assets, index });
  }, []);

  // update the live asset list in the viewer as the grid loads more buckets
  const handleAssetsChange = useCallback((assets: Asset[]) => {
    setViewer((v) => (v ? { ...v, assets } : null));
  }, []);

  // called by Fullscreen when near the end; delegates to the mounted grid
  const handleNearEnd = useCallback(() => {
    loadNextRef.current?.();
  }, []);

  // Close the viewer and return focus to the thumbnail of the photo last shown
  // (the user may have paged left/right inside the viewer). The grid was never
  // unmounted, so its scroll position and loaded buckets are intact and the
  // target thumb is already in the DOM; focus() also scrolls it into view.
  // Stable identity (no viewer dep) so Fullscreen's key-handler effect doesn't
  // tear down and re-attach on every bucket load (which would create a brief gap
  // where key presses are dropped). viewerRef always mirrors the latest viewer.
  const closeViewer = useCallback(
    (index: number) => {
      const id = viewerRef.current?.assets[index]?.id;
      setViewer(null);
      setTimeout(() => {
        const el = id
          ? rootRef.current?.querySelector<HTMLElement>(`[data-asset-id="${id}"]`)
          : null;
        // instant=true: avoid the eased RAF animation fighting magic-remote scroll
        if (el) focus(el, true);
        else focusFirstContent();
      }, 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Focus the first content (non-sidebar) focusable. The grid loads its first
  // bucket asynchronously, so retry for a short window until a thumbnail exists
  // rather than giving up on the first (empty) tick.
  const focusFirstContent = (attempt = 0) => {
    // Skip the sidebar and any header control (e.g. the album back button) so a
    // freshly-opened view lands on the first content item, not a chrome button.
    const el = focusables().find(
      (e) => !e.hasAttribute('data-sidebar') && !e.hasAttribute('data-noautofocus'),
    );
    if (el) {
      el.focus();
    } else if (attempt < 30) {
      setTimeout(() => focusFirstContent(attempt + 1), 100);
    }
  };

  const onEdge = useCallback((dir: string) => {
    if (dir === 'left' && !sidebarOpen) {
      openSidebarFocusActive();
    } else if (dir === 'right' && sidebarOpen) {
      collapseSidebar();
    }
  }, [sidebarOpen]);

  // Back hierarchy:
  //  viewer        -> close to grid (Fullscreen handles its own Back; this is
  //                   the fallback if it ever bubbles up)
  //  album open    -> back to album list
  //  sidebar open  -> quit via webOS's native exit
  //  grid (closed) -> open sidebar, focus the active tab
  const onBack = useCallback(() => {
    if (viewer) {
      closeViewer(viewer.index);
    } else if (album) {
      setAlbum(null);
    } else if (sidebarOpen) {
      exitApp();
    } else {
      openSidebarFocusActive();
    }
  }, [viewer, album, sidebarOpen, closeViewer]);

  // disable the grid/sidebar remote handler while an overlay that owns the keys
  // is up — the fullscreen viewer, or the logout confirmation dialog
  useRemote({ onBack, onEdge, enabled: !viewer && !confirmLogout });

  const navigate = (r: Route) => {
    albumsRestore.current = null;
    setAlbum(null);
    setRoute(r);
    setSidebarOpen(false);
    // drop focus off the clicked nav button (pointer clicks otherwise keep it
    // focused) and move focus to the content grid
    (document.activeElement as HTMLElement | null)?.blur();
    setTimeout(() => focusFirstContent(), 0);
  };

  // Sign-out from the sidebar asks first. Remember the trigger button so a
  // cancel returns focus to it instead of stranding the d-pad on nothing.
  const logoutTrigger = useRef<HTMLElement | null>(null);
  const requestLogout = () => {
    logoutTrigger.current = document.activeElement as HTMLElement | null;
    setConfirmLogout(true);
  };
  const cancelLogout = () => {
    setConfirmLogout(false);
    setTimeout(() => logoutTrigger.current?.focus(), 0);
  };
  const doLogout = async () => {
    setConfirmLogout(false);
    await logout();
    clearSession();
    onLogout();
  };

  return (
    <div class="home" ref={rootRef}>
      {/* Viewer is an overlay (position:fixed), NOT a replacement for the grid.
          Keeping the grid mounted underneath preserves its scroll position and
          loaded buckets, so closing returns to the exact spot. */}
      {viewer && (
        <Fullscreen
          assets={viewer.assets}
          index={viewer.index}
          onClose={closeViewer}
          onNearEnd={handleNearEnd}
        />
      )}
      <Sidebar
        open={sidebarOpen}
        active={route}
        userName={user?.name}
        onNavigate={navigate}
        onLogout={requestLogout}
      />
      {confirmLogout && (
        <ConfirmDialog
          title="Sign out?"
          message="You'll need to sign in again to view your photos."
          confirmLabel="Sign out"
          destructive
          onConfirm={doLogout}
          onCancel={cancelLogout}
        />
      )}
      {/* Invisible click-catcher over the content while the sidebar is open: a
          pointer click anywhere outside the sidebar (magic remote / mouse)
          collapses it. Transparent — no dark scrim — and it sits below the
          sidebar (z-index) so sidebar clicks still land on their buttons. */}
      {sidebarOpen && (
        <div class="sidebar-catch" onClick={collapseSidebar} />
      )}

      <main class={'content ' + (sidebarOpen ? 'shifted' : '')}>
        {/* keyed wrapper: changing view replaces it, replaying the fade-in so
            switching tabs eases in instead of swapping abruptly */}
        {/* Floating sort toggle, top-right of the content. data-noautofocus keeps
            autofocus on the first thumbnail; d-pad still reaches it. Hidden on
            Search (no order to flip). */}
        {section && (
          <button
            data-focusable
            data-noautofocus
            data-header-nav
            class={'sort-btn focusable' + (sortHidden ? ' hidden' : '')}
            onClick={toggleSort}
            aria-label={sort[section] === 'asc' ? 'Oldest first' : 'Newest first'}
            title={sort[section] === 'asc' ? 'Oldest first' : 'Newest first'}
          >
            <Icon name={sort[section] === 'asc' ? 'sortAsc' : 'sortDesc'} size={28} />
          </button>
        )}
        <div
          class="view-enter"
          key={
            (album ? 'album:' + album.id : route) +
            (section ? ':' + sort[section] : '')
          }
        >
          {album ? (
            <div class="album-view">
              <header class="album-header">
                <button
                  data-focusable
                  data-noautofocus
                  data-header-nav
                  class="album-back focusable"
                  onClick={() => setAlbum(null)}
                  aria-label="Back to albums"
                >
                  <Icon name="back" size={28} />
                </button>
                <div class="album-header-text">
                  <h1 class="album-title">{album.albumName}</h1>
                  <div class="album-subtitle">
                    {album.assetCount} item{album.assetCount === 1 ? '' : 's'}
                    {album.shared ? ' · shared' : ''}
                  </div>
                </div>
              </header>
              <PhotoGrid
                loadBuckets={() => getAlbumBuckets(album.id, sort.album)}
                loadBucket={(tb) => getAlbumBucket(album.id, tb, sort.album)}
                onOpen={openViewer}
                loadNextUnloaded={loadNextRef}
                onAssetsChange={handleAssetsChange}
              />
            </div>
          ) : route === 'timeline' ? (
            <PhotoGrid
              loadBuckets={() => getTimelineBuckets(sort.timeline)}
              loadBucket={(tb) => getBucket(tb, sort.timeline)}
              onOpen={openViewer}
              loadNextUnloaded={loadNextRef}
              onAssetsChange={handleAssetsChange}
            />
          ) : route === 'favorites' ? (
            <PhotoGrid
              loadBuckets={() => getFavoriteBuckets(sort.favorites)}
              loadBucket={(tb) => getFavoriteBucket(tb, sort.favorites)}
              onOpen={openViewer}
              loadNextUnloaded={loadNextRef}
              onAssetsChange={handleAssetsChange}
            />
          ) : route === 'search' ? (
            <Search onOpen={openViewer} />
          ) : (
            <Albums
              order={sort.albums}
              onOpenAlbum={(a) => {
                const grid =
                  rootRef.current?.querySelector<HTMLElement>('.album-grid');
                albumsRestore.current = {
                  scrollTop: grid?.scrollTop ?? 0,
                  albumId: a.id,
                };
                setAlbum(a);
              }}
              restore={albumsRestore.current}
              onRestored={() => {
                albumsRestore.current = null;
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
