# JEAN PERFUMES — Vercel + Neon

Estructura: `public/index.html` (interfaz) · `api/rpc.js` (servidor) · `schema.sql` (tablas) · `package.json` · `vercel.json`.

## 1) Neon
1. console.neon.tech → New Project (región AWS São Paulo `aws-sa-east-1`).
2. SQL Editor → pega todo `schema.sql` → Run.
3. Dashboard → Connect → copia la cadena **Pooled connection**.

## 2) GitHub
1. Repositorio nuevo **privado** `jean-perfumes`.
2. Sube estos archivos tal cual (mantén las carpetas `api` y `public`). No subas `.env`.

## 3) Vercel
1. Add New → Project → importa el repositorio. Framework: **Other**. Sin comando de build.
2. Settings → Environment Variables:
   - `DATABASE_URL` = cadena pooled de Neon
   - `INITIAL_USER` = Jean  ·  `INITIAL_PASSWORD` = 080520 (o la que prefieras)
3. Deploy. Abre la URL, entra con Jean / 080520: te obliga a cambiar la clave en Ajustes.
   Haz ese primer ingreso tú mismo, enseguida; después de crear el usuario, las variables INITIAL_* ya no se usan.

## Notas
- Importes en céntimos enteros. Reparto de gastos por resto mayor (suma exacta), calculado en el servidor.
- Venta: bloqueo de lote, validación de stock, clave de idempotencia y transacción.
- Sin integración oficial con Shalom: el recibo es un documento interno.
- Pendiente: devoluciones parciales, pagos a proveedores, caja, Excel/PDF de reportes, respaldos (usa las ramas/restauración de Neon).
