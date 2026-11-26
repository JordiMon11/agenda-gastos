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

## Importar movimientos del banco

En **Movimientos → Importar** (también desde Inicio, Gastos y Cuentas). El usuario solo tiene que:

1. **Elegir el archivo** que descarga de su banca online.
2. **Elegir la cuenta** en la que se apuntan los movimientos.
3. **Revisar** la tabla de movimientos detectados.
4. Pulsar **CONFIRMAR E IMPORTAR MOVIMIENTOS**.

**Formatos:** CSV, Excel (XLSX y XLS antiguo, también los «XLS» que en realidad son HTML o XML), PDF con texto, PDF escaneado y fotos (OCR en el propio dispositivo), OFX/QFX, CAMT.053 (XML ISO 20022) y Norma 43 (formato AEB de los bancos españoles).

- **Bancos:** se reconoce el banco por el código de entidad del IBAN, el nombre del archivo o el contenido. Por ejemplo CaixaBank, BBVA, Santander, Sabadell, ING, Openbank, Bankinter, Unicaja, Abanca, Kutxabank, Ibercaja, Cajamar, EVO, Revolut o N26.
- **Columnas:** si no se reconocen, aparece una pantalla para indicar qué es cada columna. Esa configuración se puede guardar para la próxima vez.
- **Importes y fechas:** se leen en formato español (`1.250,50 €`, `-45,90`, `45,90-`). Los cargos nunca se confunden con los abonos. Si el extracto no indica el signo, se deduce por la evolución del saldo; si no hay saldo, la fila se marca para revisar.
- **Clasificación gratuita:** se usan, por este orden:
  1. tus reglas;
  2. tu historial con ese comercio;
  3. un diccionario de comercios españoles (Mercadona → Supermercado, Repsol → Gasolina, Netflix → Suscripciones…).

  Si cambias una categoría al revisar, se guarda como regla. No se inventa ningún establecimiento.
- **Tipos de movimiento:** gasto, pago con tarjeta, recibo, comisión, retirada e ingreso de efectivo, ingreso, devolución (enlazada con la compra original) y transferencia entre tus cuentas (no cuenta como gasto ni como ingreso).
- **Pagos fijos:** si un cargo coincide con un pago fijo ya creado, se marca como pagado. Si se repite cada mes, se propone crearlo.
- **Duplicados:** cada movimiento lleva una huella (cuenta + identificador del banco, o fecha + importe + descripción + saldo). Importar dos veces el mismo archivo no duplica nada.
  - Los parecidos a un movimiento manual se muestran como «¿Duplicado?» y tú decides: no importarlo, vincularlo o importarlo igualmente.
  - Nunca se borra nada que ya existiera.
- **Historial de importaciones:** muestra el archivo, el banco, la cuenta, la fecha, las cifras, el estado y quién lo importó.
  - Una importación se puede **revertir** (con confirmación) si no has modificado esos movimientos después.
  - Queda un registro de cada importación y de cada reversión.
- **Seguridad:**
  - El extracto **no se guarda**: se lee en memoria y se descarta.
  - Solo su dueño ve sus importaciones.
  - Hay límite de tamaño (`IMPORT_MAX_MB`, por defecto 10 MB) y se rechazan los ejecutables y los XML con entidades.
  - Los Excel se comprueban antes de descomprimirlos para evitar archivos «bomba».
  - Ningún dato bancario se envía a servicios de IA.
- **Conexión directa con el banco (futuro):** en `server/openbanking.js` está preparada la estructura para un proveedor PSD2 autorizado, solo de lectura y con consentimiento.
  - Nunca se piden ni guardan contraseñas del banco, ni se hacen pagos.
  - Los movimientos sincronizados pasarían por el mismo proceso de duplicados y clasificación.

## Clasificación automática

Todos los movimientos se clasifican solos:

- los extractos importados y los bancos conectados;
- los gastos que apuntas sin elegir categoría;
- los tickets;
- los ingresos, las transferencias y las devoluciones.

Para cada movimiento se guardan:

- la **categoría** y la **subcategoría**;
- el **tipo**: gasto, compra con tarjeta, recibo, suscripción, comisión, retirada o ingreso de efectivo, transferencia a otra persona, traspaso entre tus cuentas, pago de la tarjeta de crédito, ingreso o devolución;
- el **comercio**, la **regla** que lo ha clasificado, la **confianza** y su **estado de revisión**.

Orden de prioridad:

1. **Tus reglas**: el comercio es…, la descripción contiene…, o viene de / va a… (por ejemplo, una nómina). Si dos reglas tuyas se contradicen, el movimiento se marca para revisar.
2. **Tu historial**: si ya has clasificado igual ese comercio al menos 2 veces.
3. **Tus palabras**: lo que añadas en *Ajustes → Clasificación*.
4. **Diccionario general de comercios españoles**: Mercadona → Alimentación, Repsol → Gasolina, Netflix → Suscripciones…
   - Cada grupo se puede cambiar de categoría o desactivar.
5. **IA (opcional y de pago)**: solo con `ANTHROPIC_API_KEY`. Se envía únicamente la descripción limpia, sin importes, números ni IBAN, y el resultado siempre queda para revisar.

**Aprende de ti:** si cambias la categoría de un movimiento, la app pregunta si quieres aplicarla a los próximos de ese comercio y a los parecidos que aún no has confirmado.

**Confianza:**

| Confianza | Qué pasa |
|---|---|
| Alta (≥ 85 %) | Se clasifica solo |
| Media (60–85 %) | Se clasifica y se marca para revisar |
| Baja | Se queda pendiente |

Los porcentajes no son inventados: salen de `node scripts/calibrar-clasificacion.js control`, que mide la precisión con `test/fixtures/clasificacion-control.json`. Son 66 movimientos con el formato real de los extractos españoles, que **no** se usan para ajustar el diccionario.

- Resultado: 56 de 56 aciertos del diccionario. Con ese tamaño de muestra se declara 94 % (el límite inferior al 95 % de seguridad), no 100 %.
- Ese conjunto imita extractos reales, pero no son tus datos: con tus movimientos la precisión puede ser algo menor. Para eso está la revisión.

**Revisión inteligente** (*Movimientos → Revisión*) muestra:

- los movimientos pendientes, los dudosos, los automáticos y los confirmados;
- los posibles duplicados;
- los posibles **traspasos entre tus cuentas** apuntados como gasto + ingreso, que puedes unir en una transferencia;
- las reglas aprendidas hace poco.

Además, puedes:

- cambiar la categoría de varios movimientos a la vez;
- **aceptar de golpe todos los de confianza alta** (se pueden seguir cambiando después).

## Mi dinero (patrimonio)

*Mi dinero → Patrimonio* muestra, sin contar nada dos veces:

- el **patrimonio total** y lo **disponible para gastar** (cuentas corrientes y efectivo, menos lo apartado en huchas, los pagos fijos pendientes y el objetivo de ahorro);
- lo **reservado para ahorro**, las cuentas corrientes, las de ahorro y depósitos, las huchas y el efectivo;
- las **deudas de tarjetas**;
- una tarjeta por cuenta con su porcentaje del total y la **evolución** de los últimos 6 meses.

**Saldo real:** el saldo de una cuenta no es la suma de todo su historial. La referencia es el último saldo que comunica el banco: por la conexión, por el extracto (columna de saldo, o los saldos del OFX y del CAMT.053) o porque lo escribes tú con «Saldo real».

- Se distinguen el saldo **contable**, el **disponible**, el **retenido** (la diferencia entre los dos) y el **estimado** (referencia + movimientos posteriores).
- Siempre se muestra la fecha de actualización. Si pasan más de 3 días, se avisa de que puede estar desfasado.
- Si tus movimientos no cuadran con el banco, se dice por cuánto.

**Huchas:** al crear una hucha se indica dónde está el dinero.

- **Dentro de una cuenta** (apartado virtual): se descuenta de lo disponible de esa cuenta y **no se suma otra vez** al total.
- **Aparte**: sí se suma.
- Las huchas antiguas que no lo indican se tratan como dentro de la cuenta principal, para que nunca se cuente dos veces el mismo dinero.

**Traspasos:** los traspasos entre tus cuentas y los pagos de la tarjeta de crédito no cuentan como gasto ni como ingreso. Si la app no está segura de que las dos cuentas son tuyas, te pide confirmación.

## Conexión con bancos (Open Banking, solo lectura)

Comparación de proveedores (noviembre de 2026):

| Proveedor | Bancos españoles | Coste | Estado |
|---|---|---|---|
| **Enable Banking** | Sí (consulta la lista en su portal) | **Gratis para uso personal** con tus propias cuentas («restricted mode») | **Elegido** |
| GoCardless Bank Account Data | Sí | Era gratis | **Cerrado a clientes nuevos desde 2025** |
| Tink (Visa) | Unos 30 en España | De pago, con contrato comercial | Descartado por coste |
| Salt Edge | Sí | De pago o bajo presupuesto, poco claro | Descartado por coste |

Cómo funciona:

1. Eliges tu banco.
2. Autorizas en la **web oficial de tu banco**. La app nunca ve ni guarda tus claves.
3. Eliges qué cuentas añadir: las de ahorro y las huchas que el banco da aparte se detectan como ahorro. También puedes enlazar una cuenta que ya tenías.
4. Se traen los saldos y los movimientos de los últimos 90 días, que pasan por la misma detección de duplicados y clasificación que un extracto.
5. Se actualiza sola cada 6 horas (los bancos limitan las consultas). Ves cuándo se actualizó cada cuenta y un historial de sincronizaciones.
6. El permiso caduca a los 90 días como máximo. La app avisa 7 días antes y al caducar, y se renueva con un clic.

Es **solo lectura**: no existe ninguna función de pagos.

- El identificador de la sesión con el banco se guarda **cifrado** (AES-256-GCM con `APP_SECRET`) y nunca sale por la API.
- Puedes **desconectar** un banco y, si quieres, **borrar los movimientos** que trajo.

Activarla con Enable Banking:

1. Crea una cuenta en enablebanking.com y una aplicación en modo restringido (gratis), con la URL de vuelta `https://TU-WEB/banco-conectado`.
2. En su panel, enlaza tus cuentas.
3. Descarga la clave privada que te da.
4. Pon en Render `ENABLEBANKING_APP_ID`, `ENABLEBANKING_PRIVATE_KEY` (el contenido del `.pem`) y `PUBLIC_URL`.

Nota: el código de Enable Banking sigue su documentación pública, pero **no se ha podido probar contra el servicio real** sin esas credenciales. Todo el flujo sí está probado con el **banco de demostración**, que solo aparece en la web de pruebas o con `OPENBANKING_PROVIDER=demo`.

**Privacidad y seguridad:**

- Cada consulta comprueba que los datos son del usuario que la pide, y hay pruebas automáticas que lo verifican. Esta app usa PostgreSQL (Neon) y no Supabase, así que no hay «RLS de Supabase».
- A la IA nunca se envían extractos ni datos bancarios completos.
- Hay registro de importaciones, reversiones y sincronizaciones.
- Tus datos se pueden exportar y borrar desde Ajustes.

## Asistente e inteligencia

El asistente funciona **gratis y sin IA externa**: entiende la pregunta con reglas en español, consulta tus datos y **calcula las cifras en el servidor**. Así nunca inventa cantidades. Separación:

1. Consulta de datos (`server/ledger.js`) → 2. Cálculo financiero (`ledger.js`, `forecast.js`, `insights.js`) → 3. Interpretación (`assistant.js`) → 4. Presentación (`public/plan.js`).

Si añades `ANTHROPIC_API_KEY`, las preguntas que las reglas no entienden se envían a Claude **solo con cifras agregadas** (sin nombres, correos ni conceptos) y con la orden de usar únicamente esos números. Variables opcionales: `ASSISTANT_MODEL` y `RECEIPT_MODEL` (por defecto `claude-opus-5-5`). Si la IA no está disponible, todo lo demás sigue funcionando.

## Entorno de pruebas (para no tocar producción)

| Rama | Se publica en | Datos |
|---|---|---|
| `main` | https://agenda-gastos.onrender.com (**producción**) | Neon (permanentes) |
| `pruebas` | https://agenda-gastos-pruebas.onrender.com (**pruebas**) | Su **propia** base de datos de Neon (permanentes). Sin ella, archivo temporal que se borra en cada actualización |

Forma de trabajar:

1. Los cambios se suben a la rama **`pruebas`**. GitHub ejecuta las **pruebas automáticas** (`.github/workflows/pruebas.yml`) y Render publica la web de pruebas, que muestra el aviso «Entorno de PRUEBAS».
2. Se prueba allí con una cuenta de prueba y, si hace falta, con **datos de demostración** (Ajustes).
3. Cuando todo está bien, se abre una *pull request* de `pruebas` a `main` (vuelven a pasar las pruebas) y al unirla se actualiza producción.

**Base de datos de pruebas:** en Neon crea una base de datos nueva (por ejemplo `pruebas`) y copia su cadena de conexión en Render → `agenda-gastos-pruebas` → Environment → `DATABASE_URL`. Cada base de datos queda marcada con su entorno y la web de pruebas **se niega a arrancar** si recibe la de producción, así que no se pueden mezclar.

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
