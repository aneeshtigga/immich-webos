import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getMapMarkers, MapMarker, describeError } from '../api/client';
import { Asset } from '../api/assets';
import { Key } from '../nav/keys';

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const CLUSTER_SIZE = 110;
const PICK_RADIUS = 90;
const TILE_URL = 'https://basemaps.cartocdn.com/dark_all';

interface Point {
  x: number;
  y: number;
}

interface Cluster {
  x: number;
  y: number;
  ids: string[];
  city: string;
}

interface Props {
  onOpen: (assets: Asset[], index: number) => void;
  keyHandlerRef: { current: ((code: number) => boolean) | null };
}

const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

function project(lat: number, lon: number): Point {
  const latitude = clamp(lat, -85.0511, 85.0511) * Math.PI / 180;
  return {
    x: (lon + 180) / 360,
    y: 0.5 - Math.log((1 + Math.sin(latitude)) / (1 - Math.sin(latitude))) / (4 * Math.PI),
  };
}

function zoomToFit(markers: MapMarker[], width: number, height: number): { center: Point; zoom: number } {
  if (!markers.length) return { center: { x: 0.5, y: 0.5 }, zoom: 2 };
  const points = markers.map((m) => project(m.lat, m.lon));
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const fitX = spanX > 0 ? (width * 0.72) / (spanX * TILE_SIZE) : 18;
  const fitY = spanY > 0 ? (height * 0.66) / (spanY * TILE_SIZE) : 18;
  const zoom = Math.floor(Math.log(Math.min(fitX, fitY)) / Math.LN2);
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    zoom: clamp(zoom, MIN_ZOOM, 13),
  };
}

export function MapView({ onOpen, keyHandlerRef }: Props) {
  const [markers, setMarkers] = useState<MapMarker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ center: { x: 0.5, y: 0.5 }, zoom: 2 });
  const viewportRef = useRef(viewport);
  const boxRef = useRef<HTMLDivElement>(null);
  const clustersRef = useRef<Cluster[]>([]);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const updateViewport = (next: typeof viewport) => {
    viewportRef.current = next;
    setViewport(next);
  };

  useEffect(() => {
    let active = true;
    getMapMarkers().then((items) => {
      if (!active) return;
      const valid = items.filter((m) =>
        m && typeof m.id === 'string' && Number.isFinite(m.lat) &&
        Number.isFinite(m.lon) && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180,
      );
      setMarkers(valid);
      const box = boxRef.current;
      const width = box?.clientWidth || 1186;
      const height = box?.clientHeight || 692;
      updateViewport(zoomToFit(valid, width, height));
    }).catch((e: unknown) => {
      if (active) setError(describeError(e));
    });
    return () => { active = false; };
  }, []);

  const size = () => ({
    width: boxRef.current?.clientWidth || 1186,
    height: boxRef.current?.clientHeight || 692,
  });

  const pan = (dx: number, dy: number) => {
    const { width, height } = size();
    const current = viewportRef.current;
    const scale = TILE_SIZE * Math.pow(2, current.zoom);
    updateViewport({
      center: {
        x: current.center.x + dx * width / 4 / scale,
        y: clamp(current.center.y + dy * height / 4 / scale, 0.01, 0.99),
      },
      zoom: current.zoom,
    });
  };

  const setZoom = (zoom: number, px?: number, py?: number) => {
    const current = viewportRef.current;
    const nextZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === current.zoom) return;
    const { width, height } = size();
    let center = current.center;
    if (px !== undefined && py !== undefined) {
      const oldScale = TILE_SIZE * Math.pow(2, current.zoom);
      const newScale = TILE_SIZE * Math.pow(2, nextZoom);
      center = {
        x: center.x + (px - width / 2) / oldScale - (px - width / 2) / newScale,
        y: clamp(center.y + (py - height / 2) / oldScale - (py - height / 2) / newScale, 0.01, 0.99),
      };
    }
    updateViewport({ center, zoom: nextZoom });
  };

  const openCluster = (cluster: Cluster) => {
    const assets: Asset[] = cluster.ids.map((id) => ({
      id,
      isImage: true,
      isVideo: false,
      duration: null,
      ratio: 1,
      createdAt: '',
    }));
    onOpen(assets, 0);
  };

  const keyHandler = (code: number): boolean => {
    switch (code) {
      case Key.Left: pan(-1, 0); return true;
      case Key.Right: pan(1, 0); return true;
      case Key.Up: pan(0, -1); return true;
      case Key.Down: pan(0, 1); return true;
      case Key.Enter: {
        const { width, height } = size();
        const nearest = clustersRef.current.reduce<Cluster | null>((best, c) => {
          const d = Math.hypot(c.x - width / 2, c.y - height / 2);
          const bestDistance = best ? Math.hypot(best.x - width / 2, best.y - height / 2) : PICK_RADIUS;
          return d < bestDistance ? c : best;
        }, null);
        if (nearest) openCluster(nearest);
        else setZoom(viewportRef.current.zoom + 2);
        return true;
      }
      case 33: case 187: case 107: setZoom(viewportRef.current.zoom + 1); return true;
      case 34: case 189: case 109: setZoom(viewportRef.current.zoom - 1); return true;
      default: return false;
    }
  };

  useEffect(() => {
    keyHandlerRef.current = keyHandler;
    return () => { keyHandlerRef.current = null; };
  });

  const { width, height } = size();
  const scale = TILE_SIZE * Math.pow(2, viewport.zoom);
  const left = viewport.center.x * scale - width / 2;
  const top = viewport.center.y * scale - height / 2;
  const tiles = useMemo(() => {
    const n = Math.pow(2, viewport.zoom);
    const firstX = Math.floor(left / TILE_SIZE);
    const lastX = Math.floor((left + width) / TILE_SIZE);
    const firstY = Math.max(0, Math.floor(top / TILE_SIZE));
    const lastY = Math.min(n - 1, Math.floor((top + height) / TILE_SIZE));
    const result: { key: string; src: string; x: number; y: number }[] = [];
    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const wrappedX = ((x % n) + n) % n;
        result.push({
          key: `${viewport.zoom}/${x}/${y}`,
          src: `${TILE_URL}/${viewport.zoom}/${wrappedX}/${y}.png`,
          x: x * TILE_SIZE - left,
          y: y * TILE_SIZE - top,
        });
      }
    }
    return result;
  }, [viewport.zoom, left, top, width, height]);

  const clusters = useMemo(() => {
    if (!markers) return [];
    const cells = new Map<string, Cluster & { sx: number; sy: number; count: number; cities: Map<string, number> }>();
    for (const marker of markers) {
      const point = project(marker.lat, marker.lon);
      let x = point.x * scale - left;
      const y = point.y * scale - top;
      x += Math.round((width / 2 - x) / scale) * scale;
      if (x < -CLUSTER_SIZE || x > width + CLUSTER_SIZE || y < -CLUSTER_SIZE || y > height + CLUSTER_SIZE) continue;
      const key = `${Math.floor(x / CLUSTER_SIZE)}:${Math.floor(y / CLUSTER_SIZE)}`;
      let cluster = cells.get(key);
      if (!cluster) {
        cluster = { x: 0, y: 0, ids: [], city: '', sx: 0, sy: 0, count: 0, cities: new Map() };
        cells.set(key, cluster);
      }
      cluster.sx += x;
      cluster.sy += y;
      cluster.count++;
      cluster.ids.push(marker.id);
      if (marker.city) cluster.cities.set(marker.city, (cluster.cities.get(marker.city) || 0) + 1);
    }
    const result = Array.from(cells.values()).map((c) => {
      const city = Array.from(c.cities.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return { x: c.sx / c.count, y: c.sy / c.count, ids: c.ids, city };
    });
    clustersRef.current = result;
    return result;
  }, [markers, scale, left, top, width, height]);

  const onWheel = (e: WheelEvent) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    setZoom(viewportRef.current.zoom + (e.deltaY < 0 ? 1 : -1), e.clientX - box.left, e.clientY - box.top);
  };

  const onMouseDown = (e: MouseEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onMouseMove = (e: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 4 && !drag.moved) return;
    drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const current = viewportRef.current;
    const currentScale = TILE_SIZE * Math.pow(2, current.zoom);
    updateViewport({
      center: {
        x: current.center.x - dx / currentScale,
        y: clamp(current.center.y - dy / currentScale, 0.01, 0.99),
      },
      zoom: current.zoom,
    });
  };
  const onMouseUp = () => {
    window.setTimeout(() => { dragRef.current = null; }, 0);
  };
  const onMapClick = (e: MouseEvent) => {
    if (dragRef.current?.moved) return;
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-cluster]');
    const index = button ? Number(button.dataset.cluster) : -1;
    if (index >= 0 && clustersRef.current[index]) openCluster(clustersRef.current[index]);
  };

  return (
    <div
      class="map-view"
      ref={boxRef}
      data-focusable
      tabIndex={0}
      aria-label="Photo map"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onClick={onMapClick}
    >
      <div class="map-tiles">
        {tiles.map((tile) => (
          <img
            key={tile.key}
            class="map-tile"
            src={tile.src}
            style={{ left: `${tile.x}px`, top: `${tile.y}px` }}
            alt=""
            draggable={false}
          />
        ))}
      </div>
      {clusters.map((cluster, index) => (
        <button
          key={index}
          type="button"
          class="map-bubble"
          data-cluster={index}
          style={{ left: `${cluster.x}px`, top: `${cluster.y}px` }}
          aria-label={`${cluster.ids.length} photos${cluster.city ? ` around ${cluster.city}` : ''}`}
          title={cluster.city || `${cluster.ids.length} photos`}
        >
          {cluster.ids.length}
        </button>
      ))}
      <div class="map-guide">
        <strong>Map controls</strong>
        <span>Arrows: move</span>
        <span>OK: open nearest group or zoom in</span>
        <span>CH+ / CH−: zoom</span>
        <span>Magic Remote: point and click · scroll to zoom · drag to move</span>
      </div>
      <div class="map-attribution">© OpenStreetMap contributors · © CARTO</div>
      {markers === null && !error && <div class="map-status">Loading photo locations…</div>}
      {error && <div class="map-status error">Could not load photo locations: {error}</div>}
      {markers?.length === 0 && !error && (
        <div class="map-status">No photos with location data yet.</div>
      )}
    </div>
  );
}
