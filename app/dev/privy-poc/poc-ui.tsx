"use client";

/** Tiny presentational helpers for the PoC diagnostic page. DISPOSABLE. */
import type { ReactNode } from "react";
import type { StorageSnapshot, SecurityGateResult, KeyClassification } from "@/lib/poc/privy/storage-audit";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <h2 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function Row({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 text-sm sm:grid-cols-[minmax(10rem,14rem)_1fr] sm:gap-3">
      <div className="text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono break-all" : "break-words"}>{value}</div>
    </div>
  );
}

export function Flag({ value }: { value: boolean | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">unknown</span>;
  return <span className={value ? "text-emerald-400" : "text-amber-400"}>{value ? "yes" : "no"}</span>;
}

export function Verdict({ result }: { result: "PASS" | "FAIL" | "BLOCKED" }) {
  const color =
    result === "PASS" ? "text-emerald-400 border-emerald-400/40" : result === "FAIL" ? "text-red-400 border-red-400/40" : "text-amber-400 border-amber-400/40";
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${color}`}>{result}</span>;
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

export function SnapshotView({
  snapshot,
  classifications,
}: {
  snapshot: StorageSnapshot;
  classifications: KeyClassification[];
}) {
  const byArea = (area: KeyClassification["area"]) => classifications.filter((c) => c.area === area);
  const renderArea = (title: string, items: KeyClassification[], unavailable = false) => (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{title}</div>
      {unavailable ? (
        <div className="text-xs italic text-muted-foreground">API unavailable in this browser</div>
      ) : items.length === 0 ? (
        <div className="text-xs italic text-muted-foreground">(none)</div>
      ) : (
        <ul className="space-y-0.5">
          {items.map((c) => (
            <li key={`${c.area}:${c.key}`} className="text-xs font-mono flex gap-2">
              <span className={sensitivityClass(c.sensitivity)}>{c.sensitivity}</span>
              <span className="text-muted-foreground">{c.owner}</span>
              <span className="break-all">{c.key}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="rounded border border-border/60 p-3 space-y-2">
      <div className="text-xs">
        <span className="font-semibold">{snapshot.label}</span>{" "}
        <span className="text-muted-foreground">
          {new Date(snapshot.capturedAtMs).toLocaleTimeString()} · {snapshot.origin}
        </span>
      </div>
      {renderArea("localStorage keys", byArea("localStorage"))}
      {renderArea("sessionStorage keys", byArea("sessionStorage"))}
      {renderArea("IndexedDB database names", byArea("indexedDB"), snapshot.indexedDB === null)}
      {renderArea("JS-visible cookie names (HttpOnly cookies never appear here)", byArea("cookie"))}
    </div>
  );
}

function sensitivityClass(s: KeyClassification["sensitivity"]): string {
  switch (s) {
    case "sensitive":
      return "text-red-400";
    case "sensitive-transient":
      return "text-orange-400";
    case "unknown":
      return "text-amber-400";
    case "marker":
      return "text-sky-400";
    default:
      return "text-muted-foreground";
  }
}

export function GateView({ gate }: { gate: SecurityGateResult }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span>Storage security gate:</span>
        <Verdict result={gate.result} />
      </div>
      <ul className="space-y-1">
        {gate.findings.map((f, i) => (
          <li key={i} className="text-xs flex gap-2">
            <span
              className={
                f.severity === "fail" ? "text-red-400" : f.severity === "block" ? "text-amber-400" : "text-muted-foreground"
              }
            >
              {f.severity}
            </span>
            <span className="break-words">{f.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
