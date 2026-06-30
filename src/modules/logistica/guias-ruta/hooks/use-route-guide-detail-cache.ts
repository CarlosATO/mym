import { useState, useCallback } from 'react';
import { RouteGuide } from '../types';
import { getRouteGuideById } from '@/app/actions/logistica/guias-ruta';

export function useRouteGuideDetailCache() {
  const [cache, setCache] = useState<Record<string, RouteGuide>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<Error | null>(null);

  const fetchDetail = useCallback(async (id: string, forceRefresh = false) => {
    if (cache[id] && !forceRefresh) return cache[id];
    
    // Si ya está cargando y no estamos forzando, ignorar.
    if (loadingIds.has(id)) return null;

    const start = performance.now();
    try {
      setLoadingIds(prev => new Set(prev).add(id));
      setError(null);
      
      const data = await getRouteGuideById(id);
      
      if (data) {
        setCache(prev => ({ ...prev, [id]: data }));
      }
      
      return data;
    } catch (err: any) {
      console.error('Error fetching route guide detail:', err);
      // SETEAR EL ERROR y NO TRAGARSELO, pasarlo hacia arriba si alguien lo await-ea
      setError(err);
      throw err;
    } finally {
      setLoadingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (process.env.NODE_ENV === 'development') {
        console.log(`openRouteGuideDetail:${id}`, Math.round(performance.now() - start), 'ms');
      }
    }
  }, [cache, loadingIds]);

  const updateCache = useCallback((id: string, partialData: Partial<RouteGuide>) => {
    setCache(prev => {
      if (!prev[id]) return prev;
      return {
        ...prev,
        [id]: { ...prev[id], ...partialData }
      };
    });
  }, []);
  
  const invalidateCache = useCallback((id: string) => {
    setCache(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return {
    cache,
    loadingIds,
    error,
    fetchDetail,
    updateCache,
    invalidateCache
  };
}
