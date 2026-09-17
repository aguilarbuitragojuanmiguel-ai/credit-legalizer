import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";

import Resumen from "./routes/Resumen";
import Movimientos from "./routes/Movimientos";
import Subir from "./routes/Subir";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold">404</h1>
        <h2 className="mt-4 text-xl font-semibold">Página no encontrada</h2>
        <a
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Ir al inicio
        </a>
      </div>
    </div>
  ),
});

const resumenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Resumen,
});

const movimientosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/movimientos",
  component: Movimientos,
});

const subirRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/subir",
  component: Subir,
});

const routeTree = rootRoute.addChildren([resumenRoute, movimientosRoute, subirRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
