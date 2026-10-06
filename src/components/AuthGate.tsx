import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { supabase } from "@/integrations/supabase/client";

const inputCls =
  "w-full rounded border border-input bg-card px-3 py-2 text-[14px] outline-none focus:border-ring";

function Login() {
  const [email, setEmail] = useState("");
  const [clave, setClave] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function entrar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCargando(true);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: clave,
    });
    setCargando(false);
    if (err) setError("Correo o contraseña incorrectos.");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form
        onSubmit={entrar}
        className="w-full max-w-sm space-y-4 rounded-md border border-border bg-card p-6"
      >
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">
            Control de Legalización de Tarjetas
          </h1>
          <p className="text-[13px] text-muted-foreground">Acta Proyecciones · Iniciar sesión</p>
        </div>
        <input
          className={inputCls}
          type="email"
          autoComplete="email"
          placeholder="Correo"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className={inputCls}
          type="password"
          autoComplete="current-password"
          placeholder="Contraseña"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          required
        />
        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        <button
          type="submit"
          disabled={cargando}
          className="w-full rounded bg-primary px-3 py-2 text-[14px] font-semibold text-primary-foreground disabled:opacity-50"
        >
          {cargando ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}

/** Muestra el login si no hay sesión; si la hay, muestra la app. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [listo, setListo] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setListo(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_evento, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!listo) return null;
  if (!session) return <Login />;
  return <>{children}</>;
}
