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

  useEffect(() => {
    setRoot(rootRef.current);
    // keep focus in the content area; sidebar only gets focus when revealed
    if (!viewer) setTimeout(focusFirstContent, 0);
  }, [route, album, viewer]);

  const openViewer = useCallback((assets: Asset[], index: number) => {
    setViewer({ assets, index });
  }, []);

  const focusFirstContent = () => {
    const el = focusables().find((e) => !e.hasAttribute('data-sidebar'));
    if (el) el.focus();
  };

  const onEdge = useCallback((dir: string) => {
    if (dir === 'left' && !sidebarOpen) {
      setSidebarOpen(true);
      // focus the sidebar after it expands
      setTimeout(() => {
        const el = focusables().find((e) => e.hasAttribute('data-sidebar'));
        if (el) el.focus();
      }, 0);
    } else if (dir === 'right' && sidebarOpen) {
      setSidebarOpen(false);
      setTimeout(focusFirstContent, 0);
    }
  }, [sidebarOpen]);

  const onBack = useCallback(() => {
    if (viewer) setViewer(null);
    else if (album) setAlbum(null);
    else if (sidebarOpen) {
      setSidebarOpen(false);
      setTimeout(focusFirstContent, 0);
    }
  }, [viewer, album, sidebarOpen]);

  // disable the grid/sidebar remote handler while the fullscreen viewer owns keys
  useRemote({ onBack, onEdge, enabled: !viewer });

  const navigate = (r: Route) => {
    setAlbum(null);
    setRoute(r);
    setSidebarOpen(false);
    setTimeout(focusFirstContent, 0);
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
