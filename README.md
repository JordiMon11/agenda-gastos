# 💸 Agenda de Gastos

Apunta tus gastos y mira en qué y dónde gastas. Funciona en **web**, **móvil** (app instalable) y **escritorio** (Windows, macOS y Linux). Todas las versiones usan la misma cuenta y los mismos datos.

## Funciones

- Cuenta vinculada a tu **correo electrónico**.
- **Gastos** con concepto, importe, fecha, **categoría**, **lugar (dónde)** y notas. Filtros, búsqueda y exportación a CSV.
- **Categorías** personalizables (icono, nombre y color).
- **Panel con gráficos**: por categoría, por día, últimos 6 meses y dónde gastas más.
- **Calendario** con el total de cada día y los gastos mensuales marcados con 🔔.
- **Gastos mensuales**: **correo de aviso X días antes** de cada cobro, registro automático y botón «marcar pagado».
- **Resumen semanal** con gráficos; se **envía por correo cada lunes**.

## Arquitectura (todo gratis)

| Pieza | Servicio gratuito | Para qué |
|---|---|---|
| Servidor web + API | **Render** (plan Free) | La web pública, usada también por el móvil y el escritorio |
| Base de datos | **Neon** (PostgreSQL Free) | Guardar los datos de forma permanente |
| Correo | **Brevo** (Free, 300/día) | Avisos y resúmenes semanales |
| Avisos programados | **GitHub Actions** | Cada 30 min despierta el servidor y revisa los avisos |
| Descargas de escritorio | **GitHub Releases** | Instaladores `.exe` / `.dmg` / `.AppImage` |
| Móvil | **PWA** | Se instala desde el navegador (Android e iPhone) |

## Publicarla en internet (paso a paso)

1. **GitHub**: sube este proyecto a un repositorio (por ejemplo `agenda-gastos`).
2. **Neon** (https://neon.tech): crea un proyecto y copia la *connection string* (`postgresql://…`).
3. **Brevo** (https://brevo.com): crea una cuenta, verifica tu correo como remitente (*Senders*) y crea una clave en *SMTP & API → API Keys*.
4. **Render** (https://render.com): entra con GitHub, ve a **New → Blueprint** y elige el repositorio. Rellena:
   - `DATABASE_URL`: la cadena de Neon.
   - `BREVO_API_KEY`: la clave de Brevo.
   - `MAIL_FROM_EMAIL`: el correo que verificaste en Brevo.
   - Deja `DESKTOP_DOWNLOAD_URL` y `RELEASES_URL` vacías por ahora.
   - Al terminar tendrás una dirección del tipo `https://agenda-gastos-xxxx.onrender.com`.
5. **Avisos**: en GitHub, abre **Settings → Secrets and variables → Actions → Variables** y crea `APP_URL` con la dirección de Render.
6. **Escritorio**: pon la dirección de Render en `desktop/config.json` (`"serverUrl"`) y súbelo. Después ve a **Actions → App de escritorio → Run workflow**. Se crean los instaladores en *Releases*.
7. En Render, rellena:
   - `DESKTOP_DOWNLOAD_URL` = `https://github.com/USUARIO/REPO/releases/latest/download/Agenda-Gastos-Setup.exe`
   - `RELEASES_URL` = `https://github.com/USUARIO/REPO/releases/latest`

### Notas del plan gratuito
- Render duerme el servidor tras 15 min sin uso. La primera visita puede tardar unos 50 s en despertarlo. La tarea de GitHub lo despierta cada 30 min para enviar los avisos.
- GitHub pausa las tareas programadas si el repositorio pasa 60 días sin cambios. Si ocurre, reactívalas desde la pestaña *Actions*.
- Los instaladores de escritorio no están firmados (firmarlos cuesta dinero). Windows puede avisar con «Windows protegió su PC»; pulsa **Más información → Ejecutar de todas formas**.

## Instalar en el móvil
- **Android (Chrome)**: abre la web y pulsa **Instalar aplicación**. También está en el menú ⋮ o en la sección *Descargar app*.
- **iPhone (Safari)**: Compartir ⬆️ → **Añadir a pantalla de inicio**.

## Desarrollo en local

```powershell
npm install
npm start
```
Abre http://localhost:3000. Sin `DATABASE_URL` los datos se guardan en `data/db.json`. Sin correo configurado, los correos se guardan en `data/outbox/`.

Para la app de escritorio en local:

```powershell
npm --prefix desktop install
npm run desktop
```

Para compilar el instalador de Windows en tu PC:

```powershell
npm run desktop:build
```
El instalador queda en `desktop/dist/`.

## Estructura

```
server/     API (Express), base de datos (PostgreSQL o JSON), correos y avisos
public/     Interfaz web + PWA (la usan también el móvil y el escritorio)
desktop/    App de escritorio (Electron) y empaquetado
.github/    Tareas automáticas (avisos y compilación del escritorio)
render.yaml Despliegue en Render
```
