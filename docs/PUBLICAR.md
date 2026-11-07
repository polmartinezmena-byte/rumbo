# Publicar Rumbo en Google Play y App Store

## 0. Avisos de AEMET (opcional, recomendado)

1. Pide tu clave gratuita en [AEMET OpenData](https://opendata.aemet.es/centrodedescargas/altaUsuario). Llega por correo.
2. Guárdala como secreto del repositorio. Así nunca queda en el código ni en la app:

   ```bash
   gh secret set AEMET_API_KEY -R polmartinezmena-byte/rumbo
   ```

3. A partir de ese momento, el workflow **Datos en directo** publica cada 15 minutos `avisos.json`, y la app lo usa en el mapa, en la ruta y en la ruta segura automática.

## 1. Android: Google Play

### Probar en tu móvil ya (sin cuenta de Google Play)

Cada cambio en `main` lanza el workflow **Android**, que compila la app. En *Actions → Android →* la última ejecución, descarga el artefacto `rumbo-android-N`: dentro está `rumbo-debug.apk`. Ábrelo en el móvil (Ajustes → permitir instalar apps de esta fuente).

### Llave de firma (una sola vez)

Google Play exige que cada versión vaya firmada con la misma llave de subida. **Guárdala con su contraseña en un sitio seguro**: sin ella no podrías publicar actualizaciones (Google permite restablecerla, pero tarda días).

1. Instala Java (incluye `keytool`):

   ```bash
   winget install EclipseAdoptium.Temurin.21.JDK
   ```

2. Crea la llave fuera del repositorio:

   ```bash
   keytool -genkeypair -v -keystore %USERPROFILE%\rumbo-upload.jks -alias rumbo -keyalg RSA -keysize 2048 -validity 10000
   ```

3. Súbela a GitHub como secretos. Los comandos piden los valores sin mostrarlos:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\rumbo-upload.jks")) | gh secret set ANDROID_KEYSTORE_BASE64 -R polmartinezmena-byte/rumbo
   gh secret set ANDROID_KEYSTORE_PASSWORD -R polmartinezmena-byte/rumbo
   gh secret set ANDROID_KEY_ALIAS -R polmartinezmena-byte/rumbo   # escribe: rumbo
   gh secret set ANDROID_KEY_PASSWORD -R polmartinezmena-byte/rumbo
   ```

4. Lanza el workflow **Android** otra vez: el artefacto incluirá `rumbo-release.aab` firmado.

### Ficha en Google Play Console

1. Crea la cuenta de desarrollador en [play.google.com/console](https://play.google.com/console): 25 $ en un único pago y verificación de identidad.
2. *Crear aplicación*: nombre «Rumbo: navegador sin conexión», idioma español, gratuita.
3. Completa:
   - **Política de privacidad**: `https://polmartinezmena-byte.github.io/rumbo/privacidad.html`
   - **Seguridad de los datos**: la app no recoge ni comparte datos. La ubicación se usa solo en el dispositivo, para la funcionalidad de la app.
   - **Categoría**: Mapas y navegación. **Clasificación de contenido**: cuestionario (sin contenido sensible).
   - **Gráficos**: icono de 512 px (`icons/icon-512.png`), gráfico de portada de 1024 × 500 y al menos 2 capturas de móvil.
4. **Prueba cerrada (obligatoria para cuentas personales nuevas)**: sube el `.aab`, añade al menos **12 testers** (sus correos de Google) y mantenla activa **14 días**. Después ya puedes pedir el acceso a producción.

## 2. iPhone: App Store (fase siguiente)

Requisitos:

- Cuenta de Apple Developer (99 €/año).
- Un Mac con Xcode, o compilar en GitHub Actions con `macos-latest` usando tus certificados de Apple guardados como secretos.
- Apple rechaza las webs «envueltas» sin funciones propias (norma 4.2). Rumbo cumple con la voz nativa, el funcionamiento sin conexión y, después, el guiado en segundo plano.
- CarPlay: hay que pedir aparte el permiso *CarPlay Navigation* a Apple (ver [CARPLAY.md](CARPLAY.md)).

Pasos: `npx cap add ios`, abrir `ios/App` en Xcode, configurar el *Bundle ID* (`io.github.polmartinezmena.rumbo`) y el equipo, añadir los textos de permiso de ubicación y subirla con *Archive → Distribute*.

## Pendiente antes de la versión 1.0 en tiendas

- [ ] Guiado con la pantalla bloqueada (plugin de ubicación en segundo plano y servicio en primer plano en Android).
- [ ] Capturas para las fichas de las tiendas.
- [ ] Comprobar que el nombre «Rumbo» no está ocupado en las tiendas.
