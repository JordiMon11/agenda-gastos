# 💸 Agenda de Gastos

Tu agenda financiera: gastos, ingresos, cuentas, presupuestos, previsiones, escáner de tickets y asistente. Funciona en **web**, **móvil** (app instalable) y **escritorio** (Windows, macOS y Linux). Todas las versiones usan la misma cuenta y los mismos datos.

## Funciones

Un centro de control de tus finanzas personales. Todo funciona **gratis** y con tus datos reales.

- **Inicio**: saldo total, cuánto puedes gastar al día, ingresos, gastos y ahorro del mes, previsión de fin de mes, presupuestos, consejos y actividad reciente.
- **Movimientos**: gastos con categoría, lugar, **cuenta**, **método de pago**, **etiquetas** y notas. Buscar, filtrar (categoría, cuenta, etiqueta), duplicar y exportar a **Excel** o **CSV**.
- **Ingresos** con origen y cuenta, en tabla ordenable.
- **Cuentas**: corriente, ahorro, efectivo, tarjetas… con su saldo calculado, **transferencias** entre cuentas (no cuentan como gasto ni ingreso) y **ajuste de saldo**. Preparada para Open Banking (PSD2) en el futuro; nunca se guardan claves del banco.
- **Calendario** mensual y semanal: gastos (rojo), ingresos (verde), facturas pendientes (azul) y pagos recurrentes (naranja), con filtros por tipo, categoría y cuenta, y balance de cada día.
- **Pagos fijos** con cualquier frecuencia (diaria, semanal, quincenal, mensual, trimestral, semestral, anual o personalizada), estados *pendiente / pagado / atrasado / en pausa*, aviso el mismo día, 1, 3 o 7 días antes, registro automático y «marcar pagado» sin duplicar.
- **Presupuestos** general y por categoría, con niveles *correcto / seguimiento / precaución / alerta / superado* (porcentajes configurables), ritmo de gasto, **propuestas calculadas con tus últimos meses** (aceptar, modificar o rechazar) e historial de cumplimiento.
- **Previsiones** del saldo a 7, 15 y 30 días, fin de mes, mes siguiente, 3 y 6 meses, con **tres escenarios**, gráfico histórico + previsto, **indicador de fiabilidad** y alertas («tu saldo podría bajar de 100 € el día 25»).
- **¿Puedo permitirme esta compra?**: simulador de compras únicas o mensuales con riesgo de liquidez y comparación de varias compras.
- **Asistente**: chat en lenguaje natural («¿cuánto he gastado en restaurantes?», «¿puedo comprar algo de 900 €?», «¿cómo ahorro 200 € al mes?»…), **consejos** con datos, ahorro potencial y prioridad, y **alertas** de duplicados, gastos anormales, fechas futuras y subidas de una categoría.
- **Escáner de tickets** con pantalla de revisión, aviso de duplicados e **historial con fotos**.
- **Informes** por semana, mes, trimestre, año o fechas: categorías, establecimientos, evolución, comparación interanual, recurrentes, presupuestos y recomendaciones. Descarga en **PDF, CSV y Excel**.
- **Avisos dentro de la app** (campana) y por correo: facturas, presupuestos, anomalías, saldo bajo, resumen semanal, informe mensual y objetivos de ahorro. Se elige cuáles recibir.
- **Ahorros** en huchas con objetivo.
- **Bienvenida** guiada (cuenta, categorías, ingresos, presupuesto y ahorro; todos los pasos se pueden saltar) y **datos de demostración** separados de los reales.
- **Tus datos**: descargar todo (JSON), exportar movimientos y eliminar la cuenta con todo su contenido.

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
render.yaml          Despliegue de producción en Render
render.pruebas.yaml  Despliegue del entorno de pruebas (rama «pruebas»)
test/                Pruebas automáticas (npm test)
```

## Seguridad

- **Verificación en dos pasos (2FA)** con app autenticadora (Google Authenticator, Microsoft Authenticator, Authy), con 10 códigos de recuperación de un solo uso.
- **Sesión en cookie** `HttpOnly`, `Secure` y `SameSite=Strict` (JavaScript no puede leerla). Los tokens se guardan en la base de datos solo como hash.
- **Protección CSRF**: las peticiones que modifican datos exigen una cabecera propia y el mismo origen.
- **Contraseñas con scrypt**, mínimo 8 caracteres con letras y números, comparación en tiempo constante.
- **Bloqueo** de la cuenta 15 minutos tras 5 contraseñas incorrectas, límite de intentos por IP y límite de códigos 2FA por intento.
- **Secreto del 2FA cifrado** con AES-256-GCM (clave en la variable `APP_SECRET`).
- **Cabeceras de seguridad**: CSP estricta (sin scripts en línea), HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, etc.
- **Avisos por correo** de accesos desde dispositivos nuevos, bloqueos y cambios de seguridad. Desde el apartado *Seguridad* puedes ver y cerrar las sesiones abiertas y consultar la actividad.

## Administración

- El **primer usuario registrado** es administrador. También se pueden fijar administradores con la variable `ADMIN_EMAILS` (separados por comas) o desde el propio panel.
- Para entrar en la administración es **obligatorio tener el 2FA activado**.
- Desde el panel: resumen de usuarios y registros, estado del sistema, lista de usuarios con buscador y filtros, editar nombre y correo, enviar enlace para restablecer contraseña, generar contraseña temporal (obliga a cambiarla al entrar), quitar el 2FA, desbloquear, cerrar sesiones, dar o quitar administrador, desactivar o reactivar cuentas y eliminarlas.
- **Ajustes de la app**: abrir o cerrar el registro de usuarios y publicar un aviso para todos.
- Todas las acciones quedan en el **registro de acciones**. El administrador **no ve los gastos ni los ingresos** de los usuarios, solo cuántos registros tienen.

## Escáner de tickets

Botón **Escanear ticket** (arriba en el ordenador, icono de escáner en el móvil, en «Nuevo gasto» y en la sección *Escáner de tickets*). Se hace una foto o se elige de la galería (JPG, PNG o HEIC si el móvil lo abre).

1. La app lee el **establecimiento, importe, fecha, hora, CIF/NIF, IVA, forma de pago, número de ticket y productos**. Lo que no aparece se deja vacío.
2. Muestra una **pantalla de revisión** con la foto, la **confianza de la lectura** y un aviso si parece un **duplicado** (no bloquea: puede ser otra compra igual).
3. Solo al pulsar **Guardar gasto** se crea el movimiento y se guarda la foto como justificante (privada: solo la ve su dueño).
4. En el **historial** puedes buscar por establecimiento, filtrar por fechas y categoría, ver y descargar la foto, editar el gasto o eliminar el ticket.

- **Gratis por defecto:** la foto se lee en el propio dispositivo con OCR (Tesseract) y reglas para tickets españoles.
- **Opcional, con IA (de pago):** con la variable `ANTHROPIC_API_KEY` el servidor usa Claude para leer el ticket. Si la IA falla, se usa el lector gratuito.

## Asistente e inteligencia

El asistente funciona **gratis y sin IA externa**: entiende la pregunta con reglas en español, consulta tus datos y **calcula las cifras en el servidor**. Así nunca inventa cantidades. Separación:

1. Consulta de datos (`server/ledger.js`) → 2. Cálculo financiero (`ledger.js`, `forecast.js`, `insights.js`) → 3. Interpretación (`assistant.js`) → 4. Presentación (`public/plan.js`).

Si añades `ANTHROPIC_API_KEY`, las preguntas que las reglas no entienden se envían a Claude **solo con cifras agregadas** (sin nombres, correos ni conceptos) y con la orden de usar únicamente esos números. Variables opcionales: `ASSISTANT_MODEL` y `RECEIPT_MODEL` (por defecto `claude-opus-5-5`). Si la IA no está disponible, todo lo demás sigue funcionando.

## Entorno de pruebas (para no tocar producción)

| Rama | Se publica en | Datos |
|---|---|---|
| `main` | https://agenda-gastos.onrender.com (**producción**) | Neon (permanentes) |
| `pruebas` | https://agenda-gastos-pruebas.onrender.com (**pruebas**) | Archivo temporal: se borran en cada actualización |

Forma de trabajar:

1. Los cambios se suben a la rama **`pruebas`**. GitHub ejecuta las **pruebas automáticas** (`.github/workflows/pruebas.yml`) y Render publica la web de pruebas, que muestra el aviso «Entorno de PRUEBAS».
2. Se prueba allí con una cuenta de prueba y, si hace falta, con **datos de demostración** (Ajustes).
3. Cuando todo está bien, se abre una *pull request* de `pruebas` a `main` (vuelven a pasar las pruebas) y al unirla se actualiza producción.

Crear la web de pruebas en Render (una sola vez): **New → Blueprint →** repositorio `agenda-gastos` **→ rama `pruebas` → Blueprint path `render.pruebas.yaml` → Apply**. Ojo: el plan gratuito de Render reparte 750 horas al mes entre todos tus servicios; la web de pruebas se duerme sola cuando no se usa, así que apenas consume.

## Pruebas automáticas

```powershell
npm test
```
Arranca el servidor con una base de datos temporal y comprueba: repeticiones (meses cortos y bisiestos), cuentas y transferencias, **aislamiento entre usuarios**, pagos fijos sin duplicados, presupuestos y avisos, previsiones y simulador, asistente (que no invente cifras), tickets con fotos privadas, anomalías, informes y exportaciones, datos de demostración y borrado de cuenta.

## Copias de seguridad

- **Cada usuario** puede descargar todos sus datos en *Ajustes → Tus datos* (JSON) y sus movimientos en CSV o Excel.
- **Base de datos completa (Neon)**: Neon guarda el historial de cambios y permite restaurar a un momento anterior (*Branches → Restore*). Para una copia manual:
  ```powershell
  pg_dump "CADENA_DE_CONEXION_DE_NEON" -Fc -f copia-agenda.dump
  ```
  y para restaurarla: `pg_restore -d "CADENA_DE_CONEXION" --clean copia-agenda.dump`.
- Los datos están en las tablas `app_state` (todo menos las fotos) y `blobs` (fotos de tickets).
- En local, basta con copiar la carpeta `data/`.

## Manual básico de uso

1. **Regístrate** y sigue la bienvenida: añade tu cuenta principal con su saldo, tus ingresos mensuales y, si quieres, un presupuesto y un objetivo de ahorro.
2. **Apunta gastos** con «Nuevo gasto» o **escanea el ticket**. Los ingresos, en *Ingresos*.
3. Añade tus **pagos fijos** (alquiler, luz, suscripciones…) para recibir avisos y que cuenten en las previsiones.
4. Pon **presupuestos** (o acepta los sugeridos) y mira cómo vas en *Presupuestos*.
5. Consulta **Previsiones** para saber cuánto tendrás y usa el simulador antes de una compra grande.
6. Pregunta lo que quieras al **Asistente** y revisa sus **consejos** y **alertas**.
7. Descarga tus **informes** en PDF, CSV o Excel cuando los necesites.
