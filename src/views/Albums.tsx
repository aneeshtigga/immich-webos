import { useEffect, useState } from 'preact/hooks';
import { getAlbums, Album } from '../api/client';
import { loadThumb } from '../api/media';

// Album list grid. Selecting an album opens it in the shared PhotoGrid via the
// onOpenAlbum callback (Home wires it to the album timeline endpoints).
export function Albums({ onOpenAlbum }: { onOpenAlbum: (album: Album) => void }) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    getAlbums()
      .then((a) =>
        a.sort((x, y) => (y.endDate || '').localeCompare(x.endDate || '')),
      )
      .then(setAlbums)
      .catch((e) => setError(e?.message || 'Failed to load albums'));
  }, []);

  if (error) return <div class="msg error">{error}</div>;
  if (!albums.length) return <div class="msg">No albums yet.</div>;

  return (
    <div class="album-grid">
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
    <button data-focusable class="album-card focusable" onClick={onSelect}>
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
