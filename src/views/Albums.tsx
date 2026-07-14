import { useEffect, useRef, useState } from 'preact/hooks';
import { getAlbums, Album } from '../api/client';
import { loadThumb } from '../api/media';
import { focus } from '../nav/focus';

// Where the list was when the user opened an album, so returning restores the
// scroll position + focus instead of jumping back to the top.
export interface AlbumsRestore {
  scrollTop: number;
  albumId: string;
}

// Album list grid. Selecting an album opens it in the shared PhotoGrid via the
// onOpenAlbum callback (Home wires it to the album timeline endpoints).
export function Albums({
  onOpenAlbum,
  restore,
  onRestored,
  order = 'desc',
}: {
  onOpenAlbum: (album: Album) => void;
  restore?: AlbumsRestore | null;
  onRestored?: () => void;
  order?: 'asc' | 'desc';
}) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [error, setError] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getAlbums()
      .then((a) =>
        // Sort by trip end date: 'desc' newest first, 'asc' oldest first so a
        // trip browses in the order it happened.
        a.sort((x, y) => {
          const cmp = (x.endDate || '').localeCompare(y.endDate || '');
          return order === 'asc' ? cmp : -cmp;
        }),
      )
      .then(setAlbums)
      .catch((e) => setError(e?.message || 'Failed to load albums'));
  }, [order]);

  // After the list (re)loads, if we came back from an opened album, put the
  // scroll + focus back where they were rather than at the first card.
  useEffect(() => {
    if (!restore || !albums.length) return;
    const grid = gridRef.current;
    if (!grid) return;
    const card = grid.querySelector<HTMLElement>(
      `[data-album-id="${restore.albumId}"]`,
    );
    // Focus first (its instant retarget writes scrollTop to re-frame the card),
    // then set our saved scrollTop last so the list stays exactly where it was.
    if (card) focus(card, true);
    grid.scrollTop = restore.scrollTop;
    onRestored?.();
  }, [albums, restore]);

  if (error) return <div class="msg error">{error}</div>;
  if (!albums.length) return <div class="msg">No albums yet.</div>;

  return (
    <div class="album-grid" ref={gridRef}>
      {albums.map((a) => (
        <AlbumCard key={a.id} album={a} onSelect={() => onOpenAlbum(a)} />
      ))}
    </div>
  );
}

function AlbumCard({ album, onSelect }: { album: Album; onSelect: () => void }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!album.albumThumbnailAssetId) return;
    let alive = true;
    loadThumb(album.albumThumbnailAssetId)
      .then((u) => alive && setSrc(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [album.albumThumbnailAssetId]);

  return (
    <button
      data-focusable
      data-album-id={album.id}
      class="album-card focusable"
      onClick={onSelect}
    >
      <div class="album-cover">
        {src ? <img class="album-cover-img" src={src} /> : <div class="thumb-ph" />}
      </div>
      <div class="album-meta">
        <div class="album-name">{album.albumName}</div>
        <div class="album-count">
          {album.assetCount} item{album.assetCount === 1 ? '' : 's'}
          {album.shared ? ' · shared' : ''}
        </div>
      </div>
    </button>
  );
}
