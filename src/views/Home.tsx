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
import { Asset } from '../api/assets';
import { PhotoGrid } from '../components/PhotoGrid';
import { Sidebar, Route } from '../components/Sidebar';
import { Albums } from './Albums';
import { Search } from './Search';
import { Fullscreen } from './Fullscreen';
import { useRemote } from '../nav/useRemote';
import { setRoot, focusables } from '../nav/focus';
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
  const rootRef = useRef<HTMLDivElement>(null);
  const user = getUser();

  // open the sidebar and focus its currently-active tab
  const openSidebarFocusActive = () => {
    setSidebarOpen(true);
    setTimeout(() => {
      const items = focusables().filter((e) => e.hasAttribute('data-sidebar'));
      const active = items.find((e) => e.classList.contains('active'));
      (active || items[0])?.focus();
    }, 0);
  };

  useEffect(() => {
    setRoot(rootRef.current);
    // keep focus in the content area; sidebar only gets focus when revealed
    if (!viewer) setTimeout(() => focusFirstContent(), 0);
  }, [route, album, viewer]);

  const openViewer = useCallback((assets: Asset[], index: number) => {
    setViewer({ assets, index });
  }, []);

  // Focus the first content (non-sidebar) focusable. The grid loads its first
  // bucket asynchronously, so retry for a short window until a thumbnail exists
  // rather than giving up on the first (empty) tick.
  const focusFirstContent = (attempt = 0) => {
    const el = focusables().find((e) => !e.hasAttribute('data-sidebar'));
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
      setSidebarOpen(false);
      setTimeout(() => focusFirstContent(), 0);
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
      setViewer(null);
    } else if (album) {
      setAlbum(null);
    } else if (sidebarOpen) {
      exitApp();
    } else {
      openSidebarFocusActive();
    }
  }, [viewer, album, sidebarOpen]);

  // disable the grid/sidebar remote handler while a fullscreen overlay
  // (viewer or exit dialog) owns the keys
  useRemote({ onBack, onEdge, enabled: !viewer });

  const navigate = (r: Route) => {
    setAlbum(null);
    setRoute(r);
    setSidebarOpen(false);
    // drop focus off the clicked nav button (pointer clicks otherwise keep it
    // focused) and move focus to the content grid
    (document.activeElement as HTMLElement | null)?.blur();
    setTimeout(() => focusFirstContent(), 0);
  };

  const doLogout = async () => {
    await logout();
    clearSession();
    onLogout();
  };

  if (viewer) {
    return (
      <Fullscreen
        assets={viewer.assets}
        index={viewer.index}
        onClose={() => setViewer(null)}
      />
    );
  }

  return (
    <div class="home" ref={rootRef}>
      <Sidebar
        open={sidebarOpen}
        active={route}
        userName={user?.name}
        onNavigate={navigate}
        onLogout={doLogout}
      />
      {sidebarOpen && <div class="scrim" />}

      <main class={'content ' + (sidebarOpen ? 'shifted' : '')}>
        {album ? (
          <PhotoGrid
            key={album.id}
            loadBuckets={() => getAlbumBuckets(album.id)}
            loadBucket={(tb) => getAlbumBucket(album.id, tb)}
            onOpen={openViewer}
          />
        ) : route === 'timeline' ? (
          <PhotoGrid loadBuckets={getTimelineBuckets} loadBucket={getBucket} onOpen={openViewer} />
        ) : route === 'favorites' ? (
          <PhotoGrid
            loadBuckets={getFavoriteBuckets}
            loadBucket={getFavoriteBucket}
            onOpen={openViewer}
          />
        ) : route === 'search' ? (
          <Search onOpen={openViewer} />
        ) : (
          <Albums onOpenAlbum={(a) => setAlbum(a)} />
        )}
      </main>
    </div>
  );
}
