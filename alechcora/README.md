# Alechcora

App de mantención SOSER. Es la **misma base que Datácora** (mismo backend, mismo
`appId` `cl.soser.datacora`, mismo Supabase/Firebase); **"Alechcora" es solo el
nombre visible** (el label), igual que en el `.exe`. UI nueva con Mapa + Gestión.

## Cómo se genera el APK (GitHub Actions)
El workflow `.github/workflows/build-apk.yml` compila el APK en la nube al hacer
push a `main` (o manualmente en la pestaña **Actions → Build APK → Run workflow**).
El `.apk` queda en:
- **Releases** (asset `Alechcora.apk`) — link directo de descarga.
- **Actions → artefacto `Alechcora-apk`**.

## Config replicada de Datácora (nada cambiado salvo el nombre)
- `appId`: **cl.soser.datacora** (NO se cambia; está registrado en backend/Supabase/Firebase).
- `appName` (label): **Alechcora**.
- `server.cleartext: true` + `CapacitorHttp` habilitado (acceso directo al backend HTTP sin CORS).
- Backend: `http://190.151.96.148:8081` (mismo direccionamiento y endpoints).
- Supabase y Firebase: mismos valores (`firebase/google-services.json` reconstruido).

## Instalar en el teléfono — importante
Como el `appId` es `cl.soser.datacora` (igual que tu Datácora) pero este APK va
**firmado con otra llave (debug)**, Android no deja instalarlo *encima* de la
Datácora actual (conflicto de firma). Para probarlo: **desinstala primero la
Datácora** del equipo, o firma este APK con la misma llave de release de Datácora.

## Pendiente (1 paso): Push notifications
El `firebase/google-services.json` ya está listo. Para encender push:
1. Agregar `@capacitor/push-notifications` a `package.json`.
2. En el workflow, copiar `firebase/google-services.json` a `android/app/` y aplicar
   el plugin `com.google.gms.google-services` en Gradle.
Se dejó fuera del primer build solo para garantizar una compilación verde.

## Desktop (alternativa)
Existe además la versión de escritorio (`launcher.py` + `web/`) que corre local y
hace de proxy al backend. Este repo es la variante **APK**.
