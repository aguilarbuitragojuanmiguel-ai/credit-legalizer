import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const nav = [
  { to: "/", label: "Resumen" },
  { to: "/movimientos", label: "Movimientos" },
  { to: "/subir", label: "Subir soporte" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground text-[13.5px]">
      <header className="bg-primary text-primary-foreground">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[15px] font-semibold tracking-tight">
              Control de Legalización de Tarjetas
            </p>
            <p className="text-[12px] opacity-70">Acta Proyecciones</p>
          </div>
          <nav className="flex gap-1">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                className="rounded px-3 py-1.5 text-[13px] font-medium opacity-70 transition-colors hover:bg-white/10 hover:opacity-100 [&.active]:bg-white/15 [&.active]:opacity-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-5 py-6">{children}</main>
    </div>
  );
}

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-border bg-card ${className}`}>
      {title ? (
        <h2 className="border-b border-border px-4 py-2.5 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function EstadoPill({ estado }: { estado: string }) {
  const cls =
    estado === "Legalizado"
      ? "bg-success/12 text-success"
      : estado === "Pendiente"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${cls}`}>
      {estado}
    </span>
  );
}
