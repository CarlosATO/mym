"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  getMermasAuthorizationPending,
  getMermasBsaleIncidents,
  getMermasRejected,
  getMermasRequests,
  getMermasWarehouse,
  getPendingMermasCount,
  getWorkerAccounts,
  getWorkerPaymentsForReview,
  type MermaAuthorizationRow,
  type MermaBsaleIncident,
  type MermaRejectedRow,
  type MermaRequest,
  type MermaWarehouseListProduct,
  type MermasBootstrap,
  type WorkerAccount,
  type WorkerPaymentReview,
} from "@/app/actions/logistica/mermas";

type Cache<T> = {
  data: T;
  loaded: boolean;
  loading: boolean;
  invalidated: boolean;
  stale: boolean;
};

type MermasModuleContext = {
  bootstrap: MermasBootstrap;
  requests: Cache<MermaRequest[]> & { query: string };
  warehouse: Cache<MermaWarehouseListProduct[]>;
  authorization: Cache<MermaAuthorizationRow[]>;
  archived: Cache<MermaRejectedRow[]>;
  workerAccounts: Cache<WorkerAccount[]> & { query: string };
  workerPayments: Cache<WorkerPaymentReview[]>;
  bsaleIncidents: Cache<MermaBsaleIncident[]>;
  pendingCount: number;
  ensureRequestsLoaded: (query?: string, force?: boolean) => Promise<void>;
  ensureWarehouseLoaded: (force?: boolean) => Promise<void>;
  ensureAuthorizationLoaded: (force?: boolean) => Promise<void>;
  ensureArchivedLoaded: (force?: boolean) => Promise<void>;
  ensureWorkerAccountsLoaded: (query?: string, force?: boolean) => Promise<void>;
  ensureWorkerPaymentsLoaded: (force?: boolean) => Promise<void>;
  invalidateMermaMovementViews: () => Promise<void>;
  invalidateRequests: () => Promise<void>;
  invalidateWarehouse: () => void;
  invalidateWorkerAccounts: () => void;
  invalidateWorkerPayments: () => void;
};

const MermasContext = createContext<MermasModuleContext | null>(null);

function staleCache<T>(data: T): Cache<T> {
  return { data, loaded: false, loading: false, invalidated: false, stale: false };
}

export function MermasModuleProvider({
  bootstrap,
  children,
}: {
  bootstrap: MermasBootstrap;
  children: React.ReactNode;
}) {
  const [requests, setRequests] = useState({ ...staleCache<MermaRequest[]>([]), query: "" });
  const [warehouse, setWarehouse] = useState(staleCache<MermaWarehouseListProduct[]>([]));
  const [authorization, setAuthorization] = useState(staleCache<MermaAuthorizationRow[]>([]));
  const [archived, setArchived] = useState(staleCache<MermaRejectedRow[]>([]));
  const [workerAccounts, setWorkerAccounts] = useState({ ...staleCache<WorkerAccount[]>([]), query: "" });
  const [workerPayments, setWorkerPayments] = useState(staleCache<WorkerPaymentReview[]>([]));
  const [bsaleIncidents, setBsaleIncidents] = useState(staleCache<MermaBsaleIncident[]>([]));
  const [pendingCount, setPendingCount] = useState(bootstrap.pendingCount);
  const requestsPromise = useRef<Promise<void> | null>(null);
  const requestsPromiseQuery = useRef<string | null>(null);
  const warehousePromise = useRef<Promise<void> | null>(null);
  const authorizationPromise = useRef<Promise<void> | null>(null);
  const archivedPromise = useRef<Promise<void> | null>(null);
  const accountsPromise = useRef<Promise<void> | null>(null);
  const accountsPromiseQuery = useRef<string | null>(null);
  const paymentsPromise = useRef<Promise<void> | null>(null);
  const incidentsInvalidated = useRef(false);

  async function ensureRequestsLoaded(query = "", force = false): Promise<void> {
    if (requestsPromise.current) {
      if (!force && requestsPromiseQuery.current === query) return requestsPromise.current;
      return requestsPromise.current.then(() => ensureRequestsLoaded(query, force));
    }
    if (!force && requests.loaded && !requests.invalidated && requests.query === query) return;
    setRequests((current) => ({ ...current, loading: true, stale: current.loaded, invalidated: false, query }));
    const promise = Promise.all([
      getMermasRequests(query),
      bsaleIncidents.loaded && !bsaleIncidents.invalidated && !incidentsInvalidated.current
        ? Promise.resolve(null)
        : bootstrap.canCreate ? getMermasBsaleIncidents() : Promise.resolve(null),
    ]).then(([requestResult, incidentsResult]) => {
      setRequests({ data: requestResult.data, loaded: true, loading: false, invalidated: false, stale: false, query });
      if (incidentsResult) {
        incidentsInvalidated.current = false;
        setBsaleIncidents({ data: incidentsResult.data, loaded: true, loading: false, invalidated: false, stale: false });
      }
    }).finally(() => {
      requestsPromise.current = null;
      requestsPromiseQuery.current = null;
    });
    requestsPromise.current = promise;
    requestsPromiseQuery.current = query;
    return promise;
  }

  async function ensureWarehouseLoaded(force = false): Promise<void> {
    if (warehousePromise.current) {
      return force ? warehousePromise.current.then(() => ensureWarehouseLoaded(true)) : warehousePromise.current;
    }
    if (!force && warehouse.loaded && !warehouse.invalidated) return;
    setWarehouse((current) => ({ ...current, loading: true, stale: current.loaded, invalidated: false }));
    const promise = getMermasWarehouse().then((result) => {
      setWarehouse({ data: result.data, loaded: true, loading: false, invalidated: false, stale: false });
    }).finally(() => { warehousePromise.current = null; });
    warehousePromise.current = promise;
    return promise;
  }

  async function ensureAuthorizationLoaded(force = false): Promise<void> {
    if (authorizationPromise.current) {
      return force ? authorizationPromise.current.then(() => ensureAuthorizationLoaded(true)) : authorizationPromise.current;
    }
    if (!force && authorization.loaded && !authorization.invalidated) return;
    setAuthorization((current) => ({ ...current, loading: true, stale: current.loaded, invalidated: false }));
    const promise = getMermasAuthorizationPending().then((result) => {
      setAuthorization({ data: result.data, loaded: true, loading: false, invalidated: false, stale: false });
    }).finally(() => { authorizationPromise.current = null; });
    authorizationPromise.current = promise;
    return promise;
  }

  async function ensureArchivedLoaded(force = false): Promise<void> {
    if (archivedPromise.current) {
      return force ? archivedPromise.current.then(() => ensureArchivedLoaded(true)) : archivedPromise.current;
    }
    if (!force && archived.loaded && !archived.invalidated) return;
    setArchived((current) => ({ ...current, loading: true, stale: current.loaded, invalidated: false }));
    const promise = getMermasRejected().then((result) => {
      setArchived({ data: result.data, loaded: true, loading: false, invalidated: false, stale: false });
    }).finally(() => { archivedPromise.current = null; });
    archivedPromise.current = promise;
    return promise;
  }

  async function ensureWorkerAccountsLoaded(query = "", force = false): Promise<void> {
    if (accountsPromise.current) {
      if (!force && accountsPromiseQuery.current === query) return accountsPromise.current;
      return accountsPromise.current.then(() => ensureWorkerAccountsLoaded(query, force));
    }
    if (!force && workerAccounts.loaded && !workerAccounts.invalidated && workerAccounts.query === query) return;
    setWorkerAccounts((current) => ({ ...current, loading: true, stale: current.loaded, invalidated: false, query }));
    const promise = getWorkerAccounts(query).then((result) => {
      setWorkerAccounts({ data: result.data, loaded: true, loading: false, invalidated: false, stale: false, query });
    }).finally(() => {
      accountsPromise.current = null;
      accountsPromiseQuery.current = null;
    });
    accountsPromise.current = promise;
    accountsPromiseQuery.current = query;
    return promise;
  }

  async function ensureWorkerPaymentsLoaded(force = false): Promise<void> {
    if (paymentsPromise.current) {
      return force ? paymentsPromise.current.then(() => ensureWorkerPaymentsLoaded(true)) : paymentsPromise.current;
    }
    if (!force && workerPayments.loaded && !workerPayments.invalidated) return;
    setWorkerPayments((current) => ({ ...current, loading: true, stale: current.loaded, invalidated: false }));
    const promise = getWorkerPaymentsForReview().then((result) => {
      setWorkerPayments({ data: result.data, loaded: true, loading: false, invalidated: false, stale: false });
    }).finally(() => { paymentsPromise.current = null; });
    paymentsPromise.current = promise;
    return promise;
  }

  function invalidateWorkerAccounts() {
    setWorkerAccounts((current) => ({ ...current, invalidated: true, stale: current.loaded }));
  }

  function invalidateWorkerPayments() {
    setWorkerPayments((current) => ({ ...current, invalidated: true, stale: current.loaded }));
  }

  async function invalidateMermaMovementViews() {
    setRequests((current) => ({ ...current, invalidated: true, stale: current.loaded }));
    setAuthorization((current) => ({ ...current, invalidated: true, stale: current.loaded }));
    setArchived((current) => ({ ...current, invalidated: true, stale: current.loaded }));
    setWarehouse((current) => ({ ...current, invalidated: true, stale: current.loaded }));
    incidentsInvalidated.current = true;
    setBsaleIncidents((current) => ({ ...current, invalidated: true, stale: current.loaded }));
    const count = await getPendingMermasCount();
    setPendingCount(count);
  }

  async function invalidateRequests() {
    setRequests((current) => ({ ...current, invalidated: true, stale: current.loaded }));
    incidentsInvalidated.current = true;
    setBsaleIncidents((current) => ({ ...current, invalidated: true, stale: current.loaded }));
    setPendingCount(await getPendingMermasCount());
  }

  function invalidateWarehouse() {
    setWarehouse((current) => ({ ...current, invalidated: true, stale: current.loaded }));
  }

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      await ensureRequestsLoaded();
      if (cancelled) return;
      const warm = async () => {
        await Promise.all([
          bootstrap.canAuthorize ? ensureAuthorizationLoaded() : Promise.resolve(),
          bootstrap.canView ? ensureArchivedLoaded() : Promise.resolve(),
        ]);
        if (bootstrap.canViewWarehouse) await ensureWarehouseLoaded();
      };
      const requestIdle = window.requestIdleCallback;
      if (typeof requestIdle === "function") requestIdle(() => void warm());
      else window.setTimeout(() => void warm(), 0);
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // These functions intentionally share promise refs and run once per provider lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MermasContext.Provider value={{
      bootstrap, requests, warehouse, authorization, archived, workerAccounts, workerPayments,
      bsaleIncidents, pendingCount, ensureRequestsLoaded, ensureWarehouseLoaded,
      ensureAuthorizationLoaded, ensureArchivedLoaded, ensureWorkerAccountsLoaded,
      ensureWorkerPaymentsLoaded, invalidateMermaMovementViews, invalidateWorkerAccounts,
      invalidateWorkerPayments, invalidateRequests, invalidateWarehouse,
    }}>
      {children}
    </MermasContext.Provider>
  );
}

export function useMermasModule() {
  const context = useContext(MermasContext);
  if (!context) throw new Error("useMermasModule debe usarse dentro de MermasModuleProvider");
  return context;
}
