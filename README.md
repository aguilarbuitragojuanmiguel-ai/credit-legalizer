# Credit Legalizer — Control de Legalización de Tarjetas

Reconstrucción fuera de Lovable: Vite + React (sin SSR) + Supabase (el mismo
proyecto que ya tenías) + Cloudflare Pages + una Cloudflare Pages Function
para la única acción que necesita permisos de servidor (subir el Excel de
legalización al bucket privado).

No se pierde nada: la base de datos, las legalizaciones y los pendientes que
ya cargaste siguen intactos en tu mismo Supabase.

## 1. Probar en tu máquina (opcional, antes de subir a GitHub)

```bash
npm install
cp .env.example .env
```

Edita `.env` y pon tu `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`
(Supabase Dashboard > Settings > API — la clave `anon`/`public`, NO la
`service_role`).

```bash
npm run dev
```

Nota: la subida de legalización (`/api/subir-legalizacion`) solo funciona
cuando corre en Cloudflare Pages (o con `wrangler pages dev`), no con
`npm run dev` normal. El resto de la app (subir extractos, ver movimientos,
marcar legalizado manualmente por cruce con Supabase) sí funciona en local.

## 2. Subir a GitHub

Desde la carpeta del proyecto:

```bash
git init
git add .
git commit -m "Credit Legalizer: reconstrucción fuera de Lovable"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/credit-legalizer.git
git push -u origin main
```

(Crea antes el repo vacío en github.com — sin README ni .gitignore, para que
no choque con el push.)

## 3. Conectar Cloudflare Pages

1. dash.cloudflare.com > **Workers & Pages** > **Create** > **Pages** >
   **Connect to Git** > selecciona el repo `credit-legalizer`.
2. Build settings:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
3. **Environment variables** (pestaña Settings del proyecto, después del
   primer deploy, o durante la configuración inicial):
   - `VITE_SUPABASE_URL` = tu URL de Supabase
   - `VITE_SUPABASE_ANON_KEY` = tu anon key
   - `SUPABASE_URL` = la misma URL (la usa la Pages Function del servidor)
   - `SUPABASE_SERVICE_ROLE_KEY` = tu service_role key (Settings > API en
     Supabase — **nunca la pongas con el prefijo `VITE_`**, o quedaría
     expuesta en el navegador)
4. Deploy. Cada push a `main` vuelve a desplegar automáticamente.

## 4. Verificar el bucket de Storage

El bucket `legalizaciones` ya debería existir en tu Supabase (Lovable lo creó
al usarlo). Confírmalo en Supabase > Storage. Si no existe, créalo como
**privado** con ese nombre exacto — la Pages Function firma URLs contra él.

## Estructura

```
functions/api/subir-legalizacion.ts   Cloudflare Pages Function (service_role)
src/
  routes/Resumen.tsx                  Pantalla de resumen por tarjeta
  routes/Movimientos.tsx              Listado, filtros, marcar legalizado
  routes/Subir.tsx                    3 modos: semana / legalización / manual
  lib/parsers/                        Davivienda PDF, Bancolombia Excel+OCR/PDF
  lib/legalizacion-upload.ts          Llama a la Pages Function
  lib/movimientos.ts                  Queries/mutations contra Supabase
  integrations/supabase/              client.ts + types.ts (mismo esquema)
  components/AppShell.tsx             Layout + nav + Card + EstadoPill
```
